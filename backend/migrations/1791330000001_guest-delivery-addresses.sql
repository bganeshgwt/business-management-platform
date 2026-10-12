-- Up Migration

-- Saved delivery addresses for regular guests (sweep SW-A-18).
--
-- A regular phones in "the usual, to the office". The cashier types the
-- mobile and the guest's addresses are offered, newest used first, to pick
-- with one tap instead of taking down "Flat 402, Sai Residency, behind the
-- Ratnadeep on Road 12" again on a busy Friday. A new address used for a
-- delivery is kept on the guest with a label (Home, Office), up to five per
-- guest: the one used longest ago makes way for a sixth.
CREATE TABLE customer_addresses (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id   BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label         VARCHAR(30) NOT NULL DEFAULT 'Home',
  address       VARCHAR(500) NOT NULL CHECK (LENGTH(TRIM(address)) > 0),
  landmark      VARCHAR(200),
  -- "Newest first" is the one last delivered to, not the one typed first.
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  use_count     INTEGER NOT NULL DEFAULT 1 CHECK (use_count >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    BIGINT REFERENCES users(id),
  updated_by    BIGINT REFERENCES users(id)
);

-- The same address typed again (any case, any spacing at the ends) is the
-- same address: it is used again, not saved twice.
CREATE UNIQUE INDEX uq_customer_addresses_text
  ON customer_addresses (customer_id, LOWER(TRIM(address)));

-- The till's lookup: one guest's addresses, newest used first.
CREATE INDEX idx_customer_addresses_guest
  ON customer_addresses (restaurant_id, customer_id, last_used_at DESC);

CREATE TRIGGER trg_customer_addresses_updated_at
BEFORE UPDATE ON customer_addresses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A guest erased at their request (the guest book's "erase") keeps no
-- address here: the database removes them the moment the guest is erased,
-- whichever screen or script erased them. The trigger reads erased_at from
-- the row as data rather than naming the column, so it does not tie the
-- column down: an older migration's Down that drops erased_at still works.
CREATE FUNCTION forget_erased_guest_addresses() RETURNS TRIGGER AS $$
BEGIN
  IF (to_jsonb(OLD) ->> 'erased_at') IS NULL AND (to_jsonb(NEW) ->> 'erased_at') IS NOT NULL THEN
    DELETE FROM customer_addresses WHERE customer_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customers_erased_forget_addresses
AFTER UPDATE ON customers
FOR EACH ROW
EXECUTE FUNCTION forget_erased_guest_addresses();

-- Down Migration

DROP TRIGGER IF EXISTS trg_customers_erased_forget_addresses ON customers;
DROP FUNCTION IF EXISTS forget_erased_guest_addresses();
DROP TABLE IF EXISTS customer_addresses;
