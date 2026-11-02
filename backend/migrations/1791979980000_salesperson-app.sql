-- Up Migration
-- The salesperson app (the staff app's /sales): a wholesale distributor's
-- field salesperson works their beat on a phone, online or with no network,
-- and the office sees each salesperson's day as it happens.
--
--   salesperson_app              the application in the paid-plans catalogue
--                                (wholesale, needs Sales orders & dispatch, off
--                                until the plan unlocks it and the owner
--                                switches it on), its permissions, and the
--                                "Salesperson" role of a wholesaler, given to
--                                existing businesses' roles.
--   wholesale_salesperson_days   a salesperson's working day: when it started
--                                and ended, with the place the phone gave,
--                                when the business records places. Locations
--                                are recorded only between the start and the
--                                end of the day (the notice and purpose the
--                                app shows): a visit's place is kept only then.
--   wholesale_visits             a visit to a shop: the check-in (time, place,
--                                its accuracy, the distance from the shop's
--                                saved place, a reason when farther than the
--                                business allows or when the shop is not on
--                                today's beat), the check-out with its outcome
--                                (an order, or no order with a reason from a
--                                fixed list and a promised payment date), and
--                                whether it was made with no network.
--   wholesale_field_orders       an order taken in the app: its visit and the
--                                total the phone worked out, so a difference
--                                from the server's price is shown, never
--                                changed silently.
--   wholesale_field_collections  a collection taken in the app, and its visit.
--   wholesale_field_refusals     an order the server refused on arrival (a
--                                credit hold, the credit limit, a new shop's
--                                cash-only rule): the office sees it, and may
--                                let a held order through; the salesperson's
--                                next try with the same request key then goes.
--   wholesale_customer_profiles  the shop's saved place (set once from a
--                                check-in, cleared by the office), and the
--                                approval of a shop added from the field (no
--                                credit, cash only, until the office approves
--                                it and sets a limit).
--   wholesale_customer_beats     the visit order of the shops on a beat.
--   wholesale_settings           the check-in distance (100 m unless changed)
--                                and whether places are recorded at all.
--   business_consents            a channel of its own, field: consent a shop
--                                gives a salesperson in person at the shop, or
--                                withdraws there, recorded as just that.
--
-- Visits, days and refusals announce each change on the business's live
-- stream (area field_sales), so the office's day report updates within a second.
-- The coordinates of a salesperson's day are their personal data: kept for
-- the purpose the app states, and erased on the business's word.

-- --- The application in the catalogue ------------------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('salesperson_app', 'Salesperson app', 'Field salespeople work their beat on a phone, online or with no network: the day started and ended, a visit to each shop with its check-in, orders at the shop''s own prices and schemes, collections by cash, cheque or UPI, and new shops for the office to approve; the office sees each salesperson''s day.', 'optional', 216);
INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES ('salesperson_app', 'wholesale', FALSE);
INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES ('salesperson_app', 'sales_orders');
INSERT INTO platform_module_prices (module_code, sold_as, monthly_price, yearly_price) VALUES ('salesperson_app', 'application', 499, 4999);

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('salesperson_app', 'view', 'See every salesperson''s day: visits and check-in places, orders, collections and new shops', 580),
 ('salesperson_app', 'create', 'Work their own day in the field: check in at shops, take orders and add new shops to approve', 581),
 ('salesperson_app', 'edit', 'Set the check-in distance and whether places are recorded; clear a shop''s saved place', 582),
 ('salesperson_app', 'approve', 'Approve shops added from the field and set their credit', 583)
) AS p(module_code, action, name, sort_order);

-- A wholesaler's field salesperson: their own beat, orders and collections.
INSERT INTO business_role_templates (code, name, description, full_access, sort_order, business_types) VALUES
 ('salesperson', 'Salesperson', 'Works their own beat on the salesperson app: starts and ends their day, checks in at shops, takes orders at each shop''s own prices, collects cash, cheques and UPI, and adds new shops for the office to approve. Changes no prices, credit or settings.', FALSE, 43, ARRAY['wholesale']);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code = 'salesperson_app'
UNION ALL SELECT 'accountant', 'salesperson_app.view'
UNION ALL SELECT 'viewer', 'salesperson_app.view'
UNION ALL SELECT 'salesperson', unnest(ARRAY['salesperson_app.create', 'sales_orders.view', 'sales_orders.create', 'receivables.create', 'contacts.view']);

-- Existing businesses' copies of the shared templates (harmless where the
-- module cannot be switched on; keeps "role copy = template"), and the new
-- role in existing wholesalers.
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code = 'salesperson_app'
WHERE NOT r.full_access AND r.template_code IN ('manager', 'accountant', 'viewer')
ON CONFLICT DO NOTHING;
SELECT business_seed_roles(id) FROM businesses WHERE business_type = 'wholesale';

-- --- Settings ----------------------------------------------------------------------------------

-- A check-in counts as at the shop within this many metres of its saved
-- place; farther, the salesperson says why and the visit is flagged. With
-- record_places off, no place is asked for or kept at all.
ALTER TABLE wholesale_settings
  ADD COLUMN checkin_distance_m SMALLINT NOT NULL DEFAULT 100 CHECK (checkin_distance_m BETWEEN 20 AND 1000),
  ADD COLUMN record_places BOOLEAN NOT NULL DEFAULT TRUE;

-- --- The shop's saved place, and a shop added from the field ------------------------------------

ALTER TABLE wholesale_customer_profiles
  ADD COLUMN latitude NUMERIC(9,6),
  ADD COLUMN longitude NUMERIC(9,6),
  ADD COLUMN place_accuracy_m INTEGER CHECK (place_accuracy_m >= 0),
  ADD COLUMN place_saved_at TIMESTAMPTZ,
  ADD COLUMN place_saved_by BIGINT REFERENCES users(id),
  -- A shop a salesperson added in the field: pending until the office approves it.
  ADD COLUMN added_by_salesperson_id BIGINT,
  ADD COLUMN approval TEXT CHECK (approval IN ('pending', 'approved')),
  ADD COLUMN approved_by BIGINT REFERENCES users(id),
  ADD COLUMN approved_at TIMESTAMPTZ,
  ADD COLUMN field_request_key UUID,
  ADD COLUMN field_request_hash CHAR(64),
  ADD CONSTRAINT wholesale_customer_profiles_added_by_fkey FOREIGN KEY (business_id, added_by_salesperson_id) REFERENCES wholesale_salespeople(business_id, id),
  ADD CONSTRAINT wholesale_customer_profiles_place CHECK ((latitude IS NULL) = (longitude IS NULL)
    AND (latitude IS NULL OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180))),
  ADD CONSTRAINT wholesale_customer_profiles_field CHECK ((approval IS NULL) = (added_by_salesperson_id IS NULL)
    AND (approval IS NULL OR (field_request_key IS NOT NULL AND field_request_hash IS NOT NULL))),
  ADD CONSTRAINT wholesale_customer_profiles_approved CHECK ((approval = 'approved') = (approved_at IS NOT NULL AND approved_by IS NOT NULL));
CREATE UNIQUE INDEX wholesale_customer_profiles_field_key ON wholesale_customer_profiles(business_id, field_request_key) WHERE field_request_key IS NOT NULL;
CREATE INDEX wholesale_customer_profiles_pending ON wholesale_customer_profiles(business_id) WHERE approval = 'pending';

-- --- Consent given in the field -----------------------------------------------------------------

-- A consent record is the evidence of how consent was obtained (DPDP Act
-- 2023), so a shop's yes given to a salesperson in person at the shop, or its
-- withdrawal there, is recorded as just that: channel field.
ALTER TABLE business_consents
  DROP CONSTRAINT business_consents_channel,
  DROP CONSTRAINT business_consents_withdrawal_channel,
  ADD CONSTRAINT business_consents_channel CHECK (channel IN ('counter', 'guests_site', 'phone', 'import', 'field')),
  ADD CONSTRAINT business_consents_withdrawal_channel CHECK (withdrawal_channel IN ('counter', 'guests_site', 'phone', 'field'));

-- The order a beat's shops are visited in (NULL: after the numbered ones, by name).
ALTER TABLE wholesale_customer_beats ADD COLUMN visit_order INTEGER CHECK (visit_order > 0);

-- --- A salesperson's day --------------------------------------------------------------------

CREATE TABLE wholesale_salesperson_days (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  salesperson_id BIGINT NOT NULL,
  -- The business's own date of the start.
  day DATE NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  start_latitude NUMERIC(9,6),
  start_longitude NUMERIC(9,6),
  start_accuracy_m INTEGER CHECK (start_accuracy_m >= 0),
  ended_at TIMESTAMPTZ,
  end_latitude NUMERIC(9,6),
  end_longitude NUMERIC(9,6),
  end_accuracy_m INTEGER CHECK (end_accuracy_m >= 0),
  -- The cash the phone counted as collected that day, said at the end (the
  -- office's settlement counts what is handed over).
  cash_in_hand NUMERIC(16,2) CHECK (cash_in_hand >= 0),
  end_note VARCHAR(300),
  start_offline BOOLEAN NOT NULL DEFAULT FALSE,
  end_offline BOOLEAN NOT NULL DEFAULT FALSE,
  start_key UUID NOT NULL,
  start_hash CHAR(64) NOT NULL,
  end_key UUID,
  end_hash CHAR(64),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, salesperson_id) REFERENCES wholesale_salespeople(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, salesperson_id, day),
  UNIQUE (business_id, start_key),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK ((ended_at IS NULL) = (end_key IS NULL) AND (end_key IS NULL) = (end_hash IS NULL)),
  CHECK ((start_latitude IS NULL) = (start_longitude IS NULL) AND (end_latitude IS NULL) = (end_longitude IS NULL)),
  CHECK (start_latitude IS NULL OR (start_latitude BETWEEN -90 AND 90 AND start_longitude BETWEEN -180 AND 180)),
  CHECK (end_latitude IS NULL OR (end_latitude BETWEEN -90 AND 90 AND end_longitude BETWEEN -180 AND 180)),
  CHECK (end_latitude IS NULL OR ended_at IS NOT NULL)
);
CREATE INDEX wholesale_salesperson_days_day ON wholesale_salesperson_days(business_id, day);

-- --- Visits -----------------------------------------------------------------------------------

CREATE TABLE wholesale_visits (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  salesperson_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  -- The shop's beat, when it was on one of the salesperson's beats that day.
  beat_id BIGINT,
  -- The business's own date of the check-in.
  day DATE NOT NULL,
  checked_in_at TIMESTAMPTZ NOT NULL,
  checked_out_at TIMESTAMPTZ,
  -- Where the phone was at the check-in, and how sure it was (metres); kept
  -- only within the salesperson's started day, while places are recorded.
  latitude NUMERIC(9,6),
  longitude NUMERIC(9,6),
  accuracy_m INTEGER CHECK (accuracy_m >= 0),
  -- From the shop's saved place, when it had one.
  distance_m INTEGER CHECK (distance_m >= 0),
  far BOOLEAN NOT NULL DEFAULT FALSE,
  far_reason VARCHAR(200),
  -- A shop not on the salesperson's beat for that day.
  off_beat BOOLEAN NOT NULL DEFAULT FALSE,
  off_beat_reason VARCHAR(200),
  -- This check-in saved the shop's place (it had none).
  place_saved BOOLEAN NOT NULL DEFAULT FALSE,
  outcome TEXT CHECK (outcome IN ('order', 'no_order')),
  no_order_reason TEXT CHECK (no_order_reason IN ('shop_closed', 'owner_away', 'enough_stock', 'dues_or_hold', 'price_or_scheme', 'other_brand', 'order_later', 'other')),
  note VARCHAR(500),
  promised_on DATE,
  promised_amount NUMERIC(16,2) CHECK (promised_amount > 0),
  -- Made on the phone with no network, and sent later.
  offline BOOLEAN NOT NULL DEFAULT FALSE,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  checkout_key UUID,
  checkout_hash CHAR(64),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, salesperson_id) REFERENCES wholesale_salespeople(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, beat_id) REFERENCES wholesale_beats(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK (latitude IS NULL OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)),
  CHECK (checked_out_at IS NULL OR checked_out_at >= checked_in_at),
  CHECK ((checked_out_at IS NULL) = (checkout_key IS NULL) AND (checkout_key IS NULL) = (checkout_hash IS NULL)),
  CHECK ((checked_out_at IS NULL) = (outcome IS NULL)),
  CHECK ((outcome = 'no_order') = (no_order_reason IS NOT NULL)),
  CHECK (no_order_reason IS DISTINCT FROM 'other' OR note IS NOT NULL),
  CHECK (promised_amount IS NULL OR promised_on IS NOT NULL),
  CHECK (far_reason IS NULL OR far),
  CHECK (off_beat_reason IS NULL OR off_beat)
);
CREATE INDEX wholesale_visits_day ON wholesale_visits(business_id, day, salesperson_id);
CREATE INDEX wholesale_visits_contact ON wholesale_visits(business_id, contact_id, checked_in_at DESC);
CREATE TRIGGER wholesale_visits_customer BEFORE INSERT OR UPDATE OF contact_id ON wholesale_visits
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- An order taken in the app: the visit it was taken on (by the visit's own
-- request key, so either may reach the server first) and the total the phone
-- worked out from its copy of the prices.
CREATE TABLE wholesale_field_orders (
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  salesperson_id BIGINT NOT NULL,
  visit_key UUID,
  phone_total NUMERIC(16,2) NOT NULL CHECK (phone_total >= 0),
  taken_at TIMESTAMPTZ NOT NULL,
  offline BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, order_id),
  FOREIGN KEY (business_id, order_id) REFERENCES wholesale_orders(business_id, id),
  FOREIGN KEY (business_id, salesperson_id) REFERENCES wholesale_salespeople(business_id, id)
);
CREATE INDEX wholesale_field_orders_visit ON wholesale_field_orders(business_id, visit_key) WHERE visit_key IS NOT NULL;

-- A collection taken in the app, and the visit it was taken on.
CREATE TABLE wholesale_field_collections (
  business_id BIGINT NOT NULL,
  collection_id BIGINT NOT NULL,
  salesperson_id BIGINT NOT NULL,
  visit_key UUID,
  taken_at TIMESTAMPTZ NOT NULL,
  offline BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, collection_id),
  FOREIGN KEY (business_id, collection_id) REFERENCES business_collections(business_id, id),
  FOREIGN KEY (business_id, salesperson_id) REFERENCES wholesale_salespeople(business_id, id)
);
CREATE INDEX wholesale_field_collections_visit ON wholesale_field_collections(business_id, visit_key) WHERE visit_key IS NOT NULL;

-- An order from the app the server refused on arrival, by its request key:
-- one row however often it is tried, until it goes through.
CREATE TABLE wholesale_field_refusals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  salesperson_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  visit_key UUID,
  -- The order's own request key: the next try with it is the same order.
  request_key UUID NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('credit_hold', 'credit_limit', 'cash_only')),
  message VARCHAR(600) NOT NULL,
  phone_total NUMERIC(16,2) CHECK (phone_total >= 0),
  tries INTEGER NOT NULL DEFAULT 1 CHECK (tries > 0),
  first_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The office let a held order through: the next try goes.
  released_by BIGINT REFERENCES users(id),
  released_at TIMESTAMPTZ,
  release_reason VARCHAR(300),
  -- The order, once a try went through.
  order_id BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, salesperson_id) REFERENCES wholesale_salespeople(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, order_id) REFERENCES wholesale_orders(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  CHECK ((released_at IS NULL) = (released_by IS NULL) AND (released_at IS NULL) = (release_reason IS NULL)),
  CHECK (released_at IS NULL OR reason = 'credit_hold')
);
CREATE INDEX wholesale_field_refusals_open ON wholesale_field_refusals(business_id, last_at DESC) WHERE order_id IS NULL;
CREATE TRIGGER wholesale_field_refusals_customer BEFORE INSERT OR UPDATE OF contact_id ON wholesale_field_refusals
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- --- Live updates --------------------------------------------------------------------------------

CREATE TRIGGER wholesale_salesperson_days_live AFTER INSERT OR UPDATE OR DELETE ON wholesale_salesperson_days
  FOR EACH ROW EXECUTE FUNCTION live_business_row('field_sales', 'id');
CREATE TRIGGER wholesale_visits_live AFTER INSERT OR UPDATE OR DELETE ON wholesale_visits
  FOR EACH ROW EXECUTE FUNCTION live_business_row('field_sales', 'id');
CREATE TRIGGER wholesale_field_refusals_live AFTER INSERT OR UPDATE OR DELETE ON wholesale_field_refusals
  FOR EACH ROW EXECUTE FUNCTION live_business_row('field_sales', 'id');

-- Down Migration
DROP TRIGGER wholesale_field_refusals_live ON wholesale_field_refusals;
DROP TRIGGER wholesale_visits_live ON wholesale_visits;
DROP TRIGGER wholesale_salesperson_days_live ON wholesale_salesperson_days;
DROP TABLE wholesale_field_refusals;
DROP TABLE wholesale_field_collections;
DROP TABLE wholesale_field_orders;
DROP TABLE wholesale_visits;
DROP TABLE wholesale_salesperson_days;
ALTER TABLE wholesale_customer_beats DROP COLUMN visit_order;
-- Without the field channel, a consent given or withdrawn in person to a
-- salesperson reads as at the counter, its note or reason saying how it really
-- was; the consent's guard waits while those rows are rewritten, so the old
-- checks hold again.
ALTER TABLE business_consents DISABLE TRIGGER business_consent_fixed;
UPDATE business_consents SET channel = 'counter',
  note = left(concat_ws(' · ', note, 'Given in person to a salesperson at the shop'), 300)
  WHERE channel = 'field';
UPDATE business_consents SET withdrawal_channel = 'counter',
  withdrawal_reason = left(concat_ws(' · ', withdrawal_reason, 'Withdrawn in person to a salesperson at the shop'), 300)
  WHERE withdrawal_channel = 'field';
ALTER TABLE business_consents ENABLE TRIGGER business_consent_fixed;
ALTER TABLE business_consents
  DROP CONSTRAINT business_consents_withdrawal_channel,
  DROP CONSTRAINT business_consents_channel,
  ADD CONSTRAINT business_consents_channel CHECK (channel IN ('counter', 'guests_site', 'phone', 'import')),
  ADD CONSTRAINT business_consents_withdrawal_channel CHECK (withdrawal_channel IN ('counter', 'guests_site', 'phone'));
DROP INDEX wholesale_customer_profiles_pending;
DROP INDEX wholesale_customer_profiles_field_key;
ALTER TABLE wholesale_customer_profiles
  DROP CONSTRAINT wholesale_customer_profiles_approved,
  DROP CONSTRAINT wholesale_customer_profiles_field,
  DROP CONSTRAINT wholesale_customer_profiles_place,
  DROP CONSTRAINT wholesale_customer_profiles_added_by_fkey,
  DROP COLUMN field_request_hash, DROP COLUMN field_request_key, DROP COLUMN approved_at, DROP COLUMN approved_by,
  DROP COLUMN approval, DROP COLUMN added_by_salesperson_id, DROP COLUMN place_saved_by, DROP COLUMN place_saved_at,
  DROP COLUMN place_accuracy_m, DROP COLUMN longitude, DROP COLUMN latitude;
ALTER TABLE wholesale_settings DROP COLUMN record_places, DROP COLUMN checkin_distance_m;
DELETE FROM business_role_permissions WHERE role_id IN (SELECT id FROM business_roles WHERE template_code = 'salesperson');
UPDATE business_memberships m SET role_id = (SELECT r2.id FROM business_roles r2 WHERE r2.business_id = m.business_id AND r2.template_code = 'viewer')
  WHERE role_id IN (SELECT id FROM business_roles WHERE template_code = 'salesperson');
DELETE FROM business_roles WHERE template_code = 'salesperson';
DELETE FROM business_role_template_permissions WHERE template_code = 'salesperson';
DELETE FROM business_role_templates WHERE code = 'salesperson';
DELETE FROM business_capabilities WHERE capability = 'salesperson_app';
DELETE FROM business_role_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'salesperson_app');
DELETE FROM business_role_template_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'salesperson_app');
DELETE FROM business_permissions WHERE module_code = 'salesperson_app';
DELETE FROM business_access_addons WHERE module_code = 'salesperson_app';
DELETE FROM business_subscription_addons WHERE module_code = 'salesperson_app';
DELETE FROM platform_plan_modules WHERE module_code = 'salesperson_app';
DELETE FROM platform_module_prices WHERE module_code = 'salesperson_app';
DELETE FROM platform_module_business_types WHERE module_code = 'salesperson_app';
DELETE FROM platform_module_dependencies WHERE module_code = 'salesperson_app';
DELETE FROM platform_modules WHERE code = 'salesperson_app';
