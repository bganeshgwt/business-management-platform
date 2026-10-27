-- Up Migration
-- Personal data under the DPDP Act 2023 and the DPDP Rules 2025, for every
-- business, the restaurant included. The shop is the data fiduciary for the
-- people it serves; the platform holds their data for it.
--
-- One model for both engines, as tasks and GST rate changes are: every row is
-- keyed on business_id, and a restaurant reaches its rows through its business
-- row (restaurant_business_id()). A person is a shop's customer contact
-- (contact_id) or a restaurant's guest (customer_id), never both.
--
--   business_privacy_notices   each business's privacy notice in versions: what is
--                              collected and why, how to ask for it or complain,
--                              the privacy contact, and a short consent notice for
--                              each purpose. A notice is kept as published.
--   business_consents          consent per purpose and per business: bills on
--                              WhatsApp or SMS, reminders, offers, and a clinic
--                              patient's treatment and reports. It takes over the
--                              clinic's health_consents (renamed here, its rows
--                              kept with their ids) and the guest book's offers
--                              consent (customers.marketing_opt_in, whose rows move
--                              here; the columns stay as a copy the database keeps
--                              for the guest book's lists, and nothing else writes
--                              them). One record per purpose: given, then withdrawn
--                              once; a new consent is a new row.
--   business_children          a person marked as a child, with the parent or
--                              guardian who gave consent. A child is never sent
--                              offers.
--   business_privacy_requests  requests to see, correct or erase a person's data,
--                              and grievances: the day received on the business's
--                              own clock, the 90-day due date, the status and the
--                              reply. An erasure is done from its request.
--   business_privacy_breaches  the breach register: when it was found, what
--                              happened, the impact, the steps taken, the people
--                              affected and each notice sent to them. It files
--                              nothing itself.
--
-- A customer contact whose data is erased keeps a nameless record
-- (business_contacts.erased_at), so its bills still add up. A guests' site
-- order carries the consents the guest ticked (table_requests), recorded
-- against the guest the order is linked to when the restaurant accepts it.
-- New permissions: privacy.view, privacy.manage and privacy.export, in both
-- engines, for owners and managers.

-- --- The module and its permissions ----------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('privacy', 'Personal data', 'The privacy notice and contact, consent for each purpose, requests from a person and the breach register (DPDP Act 2023).', 'core', 45);

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('privacy', 'view', 'See the privacy notice, the requests and the breach register', 132),
 ('privacy', 'manage', 'Publish the privacy notice, answer requests, erase a person''s data and keep the breach register', 133),
 ('privacy', 'export', 'See or export everything held about one person', 134)
) AS p(module_code, action, name, sort_order);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code = 'privacy';
-- Existing businesses' Manager roles, as their template now has it.
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, p.code FROM business_roles r
JOIN business_permissions p ON p.module_code = 'privacy'
WHERE r.template_code = 'manager' AND NOT r.full_access
ON CONFLICT DO NOTHING;

-- The restaurant's own permission list (its role editor), the same codes.
-- Owners and managers get them, and so does any restaurant role that already
-- runs the restaurant's access (it manages users and roles).
INSERT INTO permissions (code, module, name, description) VALUES
 ('privacy.view', 'privacy', 'See the privacy notice, the requests and the breach register', NULL),
 ('privacy.manage', 'privacy', 'Publish the privacy notice, answer requests, erase a guest''s data and keep the breach register', NULL),
 ('privacy.export', 'privacy', 'See or export everything held about one guest', NULL);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.module = 'privacy'
WHERE (r.restaurant_id IS NULL AND r.is_system = TRUE AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER'))
   OR (r.restaurant_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM role_permissions x JOIN permissions xp ON xp.id = x.permission_id
                   WHERE x.role_id = r.id AND xp.code = 'users.manage')
       AND EXISTS (SELECT 1 FROM role_permissions x JOIN permissions xp ON xp.id = x.permission_id
                   WHERE x.role_id = r.id AND xp.code = 'roles.manage'))
ON CONFLICT DO NOTHING;

-- --- A customer contact whose data is erased -----------------------------------------

ALTER TABLE business_contacts
  ADD COLUMN erased_at TIMESTAMPTZ,
  ADD COLUMN erased_by BIGINT REFERENCES users(id),
  ADD CONSTRAINT business_contacts_erased CHECK ((erased_at IS NULL) = (erased_by IS NULL));

-- --- A phone number is never a condition --------------------------------------------

-- A repair taken in and a warranty registered no longer need the customer's
-- phone: asking for one as a condition is an unfair trade practice. The job
-- card's number, the serial and the bill find them; a phone, when given, is
-- for the ready message.
ALTER TABLE electronics_repair_jobs ALTER COLUMN customer_phone DROP NOT NULL, ALTER COLUMN phone_digits DROP NOT NULL;
ALTER TABLE electronics_warranties ALTER COLUMN customer_phone DROP NOT NULL, ALTER COLUMN phone_digits DROP NOT NULL;

-- --- Erasure on records kept closed ---------------------------------------------------

-- A customer's data erased at their request leaves their copies on closed
-- records too (a job card's customer name and phone, a booking's ID): each of
-- these tables' guards lets exactly that change through, and nothing else,
-- once the customer's contact is erased. The columns are the ones
-- modules/personal-data/services/personalDataShop.js blanks.
CREATE FUNCTION business_privacy_erasing(tbl TEXT, before JSONB, after JSONB) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
  open_fields TEXT[] := CASE tbl
    WHEN 'business_exchange_vouchers' THEN ARRAY['customer_name', 'customer_phone']
    WHEN 'business_quotations' THEN ARRAY['customer_name', 'customer_phone']
    WHEN 'books_customer_orders' THEN ARRAY['customer_name', 'phone', 'notes']
    WHEN 'electronics_repair_jobs' THEN ARRAY['customer_name', 'customer_phone', 'phone_digits', 'passcode']
    WHEN 'electronics_warranties' THEN ARRAY['customer_name', 'customer_phone', 'phone_digits']
    WHEN 'salon_client_notes' THEN ARRAY['body']
    WHEN 'agri_farmers' THEN ARRAY['village', 'relative_name', 'land_acres', 'crops', 'farmer_id', 'notes']
    WHEN 'hardware_sites' THEN ARRAY['name', 'address', 'contact_person', 'phone', 'active']
    WHEN 'garage_job_cards' THEN ARRAY['customer_name', 'customer_phone']
    WHEN 'rental_bookings' THEN ARRAY['customer_name', 'customer_phone', 'id_kind', 'id_ref', 'licence_no', 'licence_valid_until', 'notes']
    WHEN 'laundry_orders' THEN ARRAY['customer_name', 'customer_phone', 'notes']
    WHEN 'optical_orders' THEN ARRAY['customer_name', 'customer_phone']
    WHEN 'lodging_stays' THEN ARRAY['guest_name', 'guest_phone', 'arrived_from', 'going_to', 'purpose', 'notes']
    WHEN 'jewellery_schemes' THEN ARRAY['member_name', 'member_phone', 'nominee_name', 'nominee_relation']
  END;
BEGIN
  IF open_fields IS NULL THEN
    RETURN FALSE;
  END IF;
  open_fields := open_fields || ARRAY['updated_at', 'updated_by'];
  IF (before - open_fields) <> (after - open_fields) THEN
    RETURN FALSE;
  END IF;
  RETURN EXISTS (SELECT 1 FROM business_contacts c WHERE c.business_id = (after->>'business_id')::bigint
    AND c.id = (after->>'contact_id')::bigint AND c.erased_at IS NOT NULL);
END $$;

CREATE OR REPLACE FUNCTION business_exchange_vouchers_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A credit voucher cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.used < OLD.used OR (to_jsonb(NEW) - ARRAY['used']) <> (to_jsonb(OLD) - ARRAY['used']) THEN
    RAISE EXCEPTION 'A credit voucher can only be spent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION business_quotations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE zone TEXT;
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A quotation is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'Quotation % is % and can no longer change', OLD.quotation_no, OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.quotation_no <> OLD.quotation_no OR NEW.location_id <> OLD.location_id OR NEW.series_id IS DISTINCT FROM OLD.series_id
     OR NEW.request_key <> OLD.request_key OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A quotation keeps its number, its location and who made it' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision NOT IN (OLD.revision, OLD.revision + 1) THEN
    RAISE EXCEPTION 'A quotation is revised one step at a time' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('billed', 'ordered') THEN
    SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
    IF OLD.valid_until < (now() AT TIME ZONE zone)::date THEN
      RAISE EXCEPTION 'Quotation % was valid until %. Revise it to bring its prices up to date first.', OLD.quotation_no, to_char(OLD.valid_until, 'DD Mon YYYY')
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION books_customer_order_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A customer order cannot be deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.advance <> OLD.advance OR NEW.collection_id IS DISTINCT FROM OLD.collection_id
     OR NEW.request_key <> OLD.request_key OR NEW.order_no <> OLD.order_no
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id THEN
    RAISE EXCEPTION 'A customer order''s customer, advance and number are fixed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('collected', 'cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'This order is already closed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'arrived' AND NEW.status = 'ordered' THEN
    RAISE EXCEPTION 'An order that has arrived cannot go back to ordered' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION electronics_repair_jobs_closed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A repair job cannot be deleted; cancel it with a reason' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('delivered', 'cancelled') AND (to_jsonb(NEW) - 'created_at') <> (to_jsonb(OLD) - 'created_at') THEN
    RAISE EXCEPTION 'Repair job % is closed and cannot change', OLD.job_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION electronics_warranties_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A warranty cannot be deleted; cancel it with a reason' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'active' OR NEW.status <> 'cancelled'
       OR (to_jsonb(NEW) - ARRAY['status', 'cancel_reason', 'cancelled_by', 'cancelled_at', 'created_at'])
          <> (to_jsonb(OLD) - ARRAY['status', 'cancel_reason', 'cancelled_by', 'cancelled_at', 'created_at']) THEN
      RAISE EXCEPTION 'A registered warranty can only be cancelled' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM business_document_lines l JOIN business_documents d ON d.business_id = l.business_id AND d.id = l.document_id
                 WHERE l.business_id = NEW.business_id AND l.id = NEW.line_id AND l.document_id = NEW.document_id
                   AND d.kind = 'sale' AND l.sku_id = NEW.sku_id AND l.lot_code = NEW.serial) THEN
    RAISE EXCEPTION 'A warranty must match the sold line, item and serial number' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION salon_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Posted % rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'created_at') <> (to_jsonb(OLD) - 'created_at') THEN
    RAISE EXCEPTION 'Posted % rows cannot be changed', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION agri_farmers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A farmer''s details are never deleted; change them instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.contact_id <> OLD.contact_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A farmer''s details stay with the customer they were added for' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION hardware_sites_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A site is never deleted; close it instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.contact_id <> OLD.contact_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A site stays with the customer it was added for' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION garage_job_cards_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A job card is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Job card % is % and can no longer change', OLD.job_no, OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.job_no <> OLD.job_no OR NEW.location_id <> OLD.location_id OR NEW.series_id IS DISTINCT FROM OLD.series_id
     OR NEW.vehicle_id <> OLD.vehicle_id OR NEW.registration_no <> OLD.registration_no OR NEW.vehicle_name <> OLD.vehicle_name
     OR NEW.contact_id <> OLD.contact_id OR NEW.customer_name <> OLD.customer_name OR NEW.customer_phone IS DISTINCT FROM OLD.customer_phone
     OR NEW.odometer_in IS DISTINCT FROM OLD.odometer_in OR NEW.tax_mode <> OLD.tax_mode
     OR NEW.request_key <> OLD.request_key OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A job card keeps its number, vehicle, customer, odometer reading in and price terms' USING ERRCODE = '23514';
  END IF;
  IF OLD.advance_collection_id IS NOT NULL AND NEW.advance_collection_id IS DISTINCT FROM OLD.advance_collection_id THEN
    RAISE EXCEPTION 'A job card keeps the advance taken on it' USING ERRCODE = '23514';
  END IF;
  IF NEW.estimate_version NOT IN (OLD.estimate_version, OLD.estimate_version + 1) THEN
    RAISE EXCEPTION 'A job card''s estimate goes up one version at a time' USING ERRCODE = '23514';
  END IF;
  IF NEW.approved_version IS DISTINCT FROM OLD.approved_version AND NEW.approved_version IS DISTINCT FROM NEW.estimate_version THEN
    RAISE EXCEPTION 'An approval is of the estimate as it stands' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'received' AND NEW.status IN ('estimate_sent', 'approved', 'in_progress', 'waiting_parts', 'ready', 'cancelled'))
    OR (OLD.status = 'estimate_sent' AND NEW.status IN ('approved', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('estimate_sent', 'in_progress', 'waiting_parts', 'ready', 'cancelled'))
    OR (OLD.status IN ('in_progress', 'waiting_parts') AND NEW.status IN ('estimate_sent', 'in_progress', 'waiting_parts', 'ready', 'cancelled'))
    OR (OLD.status = 'ready' AND NEW.status IN ('estimate_sent', 'in_progress', 'waiting_parts', 'delivered', 'cancelled'))) THEN
    RAISE EXCEPTION 'Job card % cannot go from % to %', OLD.job_no, replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'approved' AND OLD.status <> 'approved' AND NEW.approved_version IS DISTINCT FROM NEW.estimate_version THEN
    RAISE EXCEPTION 'Job card % is approved once the owner approves the estimate as it stands', OLD.job_no USING ERRCODE = '23514';
  END IF;
  -- A job card with lines is delivered with its bill (or bills).
  IF NEW.status = 'delivered' AND NEW.document_id IS NULL AND NEW.insurer_document_id IS NULL
     AND EXISTS (SELECT 1 FROM garage_job_card_lines WHERE business_id = NEW.business_id AND job_card_id = NEW.id) THEN
    RAISE EXCEPTION 'Job card % is delivered with its bill', OLD.job_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION rental_bookings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE zone TEXT; unit RECORD;
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A booking is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('returned', 'cancelled') THEN
    IF (to_jsonb(NEW) - ARRAY['updated_by', 'updated_at']) <> (to_jsonb(OLD) - ARRAY['updated_by', 'updated_at']) THEN
      RAISE EXCEPTION 'Booking % is % and no longer changes', OLD.booking_no, OLD.status USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.location_id <> OLD.location_id OR NEW.booking_no <> OLD.booking_no OR NEW.series_id IS DISTINCT FROM OLD.series_id OR NEW.contact_id <> OLD.contact_id
     OR NEW.customer_name <> OLD.customer_name OR NEW.customer_phone IS DISTINCT FROM OLD.customer_phone OR NEW.request_key <> OLD.request_key
     OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A booking keeps its number, its hirer and where it was made' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'quote' AND NEW.status IN ('reserved', 'cancelled'))
       OR (OLD.status = 'reserved' AND NEW.status IN ('out', 'cancelled')) OR (OLD.status = 'out' AND NEW.status = 'returned')) THEN
    RAISE EXCEPTION 'Booking % cannot go from % to %', OLD.booking_no, OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
  IF NEW.out_at <> OLD.out_at AND OLD.status NOT IN ('quote', 'reserved') THEN
    RAISE EXCEPTION 'Booking % is handed over: its out time stays as it was', OLD.booking_no USING ERRCODE = '23514';
  END IF;
  IF (NEW.out_at <> OLD.out_at OR (OLD.status = 'quote' AND NEW.status = 'reserved'))
     AND NEW.out_at < (date_trunc('day', now() AT TIME ZONE zone) AT TIME ZONE zone) THEN
    RAISE EXCEPTION 'Booking % would start on a day that has passed: give it times today or later', OLD.booking_no USING ERRCODE = '23514';
  END IF;
  IF (NEW.checked_out_at, NEW.checked_out_by, NEW.checkout_key, NEW.checkout_hash, NEW.id_kind, NEW.id_ref, NEW.licence_no, NEW.licence_valid_until,
      NEW.deposit_waived_by, NEW.deposit_waiver) IS DISTINCT FROM (OLD.checked_out_at, OLD.checked_out_by, OLD.checkout_key, OLD.checkout_hash, OLD.id_kind,
      OLD.id_ref, OLD.licence_no, OLD.licence_valid_until, OLD.deposit_waived_by, OLD.deposit_waiver)
     AND NOT (OLD.status = 'reserved' AND NEW.status = 'out') THEN
    RAISE EXCEPTION 'Booking %: what was recorded at the handover stays as it was', OLD.booking_no USING ERRCODE = '23514';
  END IF;
  IF NEW.returned_at IS DISTINCT FROM OLD.returned_at AND NOT (OLD.status = 'out' AND NEW.status = 'returned') THEN
    RAISE EXCEPTION 'Booking % is back when the last of it is returned', OLD.booking_no USING ERRCODE = '23514';
  END IF;
  IF (NEW.cancelled_at, NEW.cancelled_by, NEW.cancel_reason, NEW.cancel_key, NEW.cancel_hash) IS DISTINCT FROM
     (OLD.cancelled_at, OLD.cancelled_by, OLD.cancel_reason, OLD.cancel_key, OLD.cancel_hash) AND NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION 'Booking %: a cancellation is recorded when it is cancelled', OLD.booking_no USING ERRCODE = '23514';
  END IF;
  IF NEW.document_id IS DISTINCT FROM OLD.document_id THEN
    IF OLD.document_id IS NOT NULL OR NEW.status = OLD.status THEN
      RAISE EXCEPTION 'Booking % is billed once: when the last of it is back, or with a cancellation charge', OLD.booking_no USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id AND kind = 'sale' AND contact_id = NEW.contact_id) THEN
      RAISE EXCEPTION 'Booking % is billed on a sale to its hirer', OLD.booking_no USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.status = 'reserved' AND NEW.status = 'out' THEN
    SELECT u.label, u.status INTO unit FROM rental_booking_lines l JOIN rental_units u ON u.business_id = l.business_id AND u.id = l.unit_id
    WHERE l.business_id = NEW.business_id AND l.booking_id = NEW.id AND u.status <> 'available' ORDER BY l.seq LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION '% is % and is not handed over', unit.label, CASE unit.status WHEN 'maintenance' THEN 'in maintenance' ELSE 'retired' END USING ERRCODE = '23514';
    END IF;
    IF rental_deposit_held(NEW.business_id, NEW.id) < NEW.deposit_due AND NEW.deposit_waiver IS NULL THEN
      RAISE EXCEPTION 'Booking % asks a deposit of %: take the rest, or record who agreed to less', OLD.booking_no, NEW.deposit_due USING ERRCODE = '23514';
    END IF;
    IF NEW.licence_valid_until IS NOT NULL AND NEW.licence_valid_until < (now() AT TIME ZONE zone)::date THEN
      RAISE EXCEPTION 'The driving licence % ran out on %: a vehicle is not handed over on it', NEW.licence_no, to_char(NEW.licence_valid_until, 'FMDD Mon YYYY')
        USING ERRCODE = '23514';
    END IF;
    IF NEW.licence_no IS NULL AND EXISTS (SELECT 1 FROM rental_booking_lines l JOIN rental_items i ON i.business_id = l.business_id AND i.id = l.item_id
       WHERE l.business_id = NEW.business_id AND l.booking_id = NEW.id AND i.vehicle IS NOT NULL AND NOT i.with_driver) THEN
      RAISE EXCEPTION 'A self-drive vehicle is handed over with the hirer''s driving licence number and expiry' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION laundry_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A garment order is never deleted; cancel its garments instead' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['promised_on', 'notes', 'updated_by', 'updated_at']) <> (to_jsonb(OLD) - ARRAY['promised_on', 'notes', 'updated_by', 'updated_at']) THEN
    RAISE EXCEPTION 'A garment order keeps its number, customer, rules, prices and terms as it was taken in' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION optical_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A spectacle order is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Spectacle order % is % and can no longer change', OLD.order_no, OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.order_no <> OLD.order_no OR NEW.location_id <> OLD.location_id OR NEW.series_id IS DISTINCT FROM OLD.series_id
     OR NEW.contact_id <> OLD.contact_id OR NEW.prescription_id <> OLD.prescription_id OR NEW.rx <> OLD.rx
     OR NEW.tax_mode <> OLD.tax_mode OR NEW.subtotal <> OLD.subtotal OR NEW.tax <> OLD.tax OR NEW.round_off <> OLD.round_off
     OR NEW.total <> OLD.total OR NEW.savings <> OLD.savings OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
     OR NEW.discount_percent IS DISTINCT FROM OLD.discount_percent OR NEW.discount_reason IS DISTINCT FROM OLD.discount_reason
     OR NEW.remake_of IS DISTINCT FROM OLD.remake_of OR NEW.remake_reason IS DISTINCT FROM OLD.remake_reason
     OR NEW.remake_cost_by IS DISTINCT FROM OLD.remake_cost_by OR NEW.advance_collection_id IS DISTINCT FROM OLD.advance_collection_id
     OR NEW.request_key <> OLD.request_key OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A spectacle order keeps its number, customer, prescription, prices and advance' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'booked' AND NEW.status IN ('at_lab', 'in_workshop', 'cancelled'))
    OR (OLD.status = 'at_lab' AND NEW.status IN ('in_workshop', 'quality_check', 'cancelled'))
    OR (OLD.status = 'in_workshop' AND NEW.status IN ('at_lab', 'quality_check', 'cancelled'))
    OR (OLD.status = 'quality_check' AND NEW.status IN ('ready', 'at_lab', 'in_workshop', 'cancelled'))
    OR (OLD.status = 'ready' AND NEW.status IN ('at_lab', 'in_workshop', 'delivered', 'cancelled'))) THEN
    RAISE EXCEPTION 'Spectacle order % cannot go from % to %', OLD.order_no, replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = '23514';
  END IF;
  -- Ready only after passing the quality check, which is then stamped.
  IF NEW.status = 'ready' AND OLD.status <> 'ready' AND (NEW.checked_at IS NOT DISTINCT FROM OLD.checked_at) THEN
    RAISE EXCEPTION 'Spectacle order % is ready only once it passes the quality check', OLD.order_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION lodging_stays_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE today DATE; room RECORD; last_night DATE; done TEXT; check_room BOOLEAN; moving_in BOOLEAN := FALSE;
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A stay is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  today := lodging_today(NEW.business_id);
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('checked_out', 'cancelled', 'no_show') THEN
      IF (to_jsonb(NEW) - ARRAY['updated_by', 'updated_at']) <> (to_jsonb(OLD) - ARRAY['updated_by', 'updated_at']) THEN
        done := CASE OLD.status WHEN 'checked_out' THEN 'checked out' WHEN 'cancelled' THEN 'cancelled' ELSE 'a no-show' END;
        RAISE EXCEPTION 'Stay % is % and no longer changes', OLD.stay_no, done USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    check_room := NEW.room_id IS NOT NULL AND (NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.room_type_id <> OLD.room_type_id OR NEW.status <> OLD.status);
    moving_in := NEW.status = 'in_house' AND (OLD.status <> 'in_house' OR NEW.room_id IS DISTINCT FROM OLD.room_id);
  ELSE
    check_room := NEW.room_id IS NOT NULL;
  END IF;
  -- The room it takes, whenever one is given, changed, or checked in to.
  IF check_room THEN
    SELECT room_no, location_id, room_type_id, status, status_note, active INTO room FROM lodging_rooms WHERE business_id = NEW.business_id AND id = NEW.room_id;
    IF NOT room.active THEN
      RAISE EXCEPTION 'Room % is out of use', room.room_no USING ERRCODE = '23514';
    END IF;
    IF room.location_id <> NEW.location_id THEN
      RAISE EXCEPTION 'Room % is at another location', room.room_no USING ERRCODE = '23514';
    END IF;
    IF room.room_type_id <> NEW.room_type_id THEN
      RAISE EXCEPTION 'Room % is of another room type: change the stay''s room type with the room', room.room_no USING ERRCODE = '23514';
    END IF;
    IF moving_in AND room.status <> 'vacant_clean' THEN
      RAISE EXCEPTION 'Room % is %: a guest checks in to a room that is vacant and clean', room.room_no,
        CASE room.status WHEN 'vacant_dirty' THEN 'not made up yet' WHEN 'occupied' THEN 'occupied' ELSE 'out of order (' || room.status_note || ')' END USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.location_id <> OLD.location_id OR NEW.stay_no <> OLD.stay_no OR NEW.series_id IS DISTINCT FROM OLD.series_id OR NEW.contact_id <> OLD.contact_id
     OR NEW.guest_name <> OLD.guest_name OR NEW.guest_phone IS DISTINCT FROM OLD.guest_phone OR NEW.request_key <> OLD.request_key
     OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A stay keeps its number, its guest and where it was made' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'reserved' AND NEW.status IN ('in_house', 'cancelled', 'no_show')) OR (OLD.status = 'in_house' AND NEW.status = 'checked_out')) THEN
    RAISE EXCEPTION 'Stay % cannot go from % to %', OLD.stay_no, replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = '23514';
  END IF;
  IF NEW.arrival <> OLD.arrival AND (OLD.status <> 'reserved' OR NEW.status <> 'reserved') THEN
    RAISE EXCEPTION 'Stay % has arrived: its arrival stays as it was', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF NEW.arrival <> OLD.arrival AND NEW.arrival < today THEN
    RAISE EXCEPTION 'Stay % would arrive on a day that has passed: give it dates from today', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'reserved' AND NEW.status = 'in_house' AND (today < NEW.arrival OR today >= NEW.departure) THEN
    RAISE EXCEPTION 'Stay % is for the nights of % to %: a guest checks in from the arrival day to the night before the departure', OLD.stay_no,
      lodging_day_words(NEW.arrival), lodging_day_words(NEW.departure - 1) USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'in_house' AND NEW.room_id IS NULL THEN
    RAISE EXCEPTION 'Stay % has a guest in the house: they keep a room', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'in_house' AND (NEW.adults <> OLD.adults OR NEW.children <> OLD.children) THEN
    RAISE EXCEPTION 'Stay %: the adults and children are the occupants recorded at check-in', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF NEW.departure <> OLD.departure AND OLD.status = 'in_house' THEN
    SELECT max(night) INTO last_night FROM lodging_charges WHERE business_id = NEW.business_id AND stay_id = NEW.id AND kind = 'room_night' AND voided_at IS NULL;
    IF last_night IS NOT NULL AND NEW.departure <= last_night THEN
      RAISE EXCEPTION 'Stay %: the night of % is posted already, so the guest leaves on % or later', OLD.stay_no, lodging_day_words(last_night),
        lodging_day_words(last_night + 1) USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'in_house' AND NEW.departure < today THEN
      RAISE EXCEPTION 'Stay % has a guest in the house: they leave today or later', OLD.stay_no USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.status = 'in_house' AND NEW.status = 'checked_out' AND NEW.departure <> GREATEST(today, NEW.arrival + 1) THEN
    RAISE EXCEPTION 'Stay % was to leave on %: extend it to today first', OLD.stay_no, lodging_day_words(OLD.departure) USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'reserved' AND NEW.status = 'no_show' AND today < NEW.arrival THEN
    RAISE EXCEPTION 'Stay % arrives on %: a guest is a no-show once the arrival day has come; cancel it instead', OLD.stay_no, lodging_day_words(NEW.arrival) USING ERRCODE = '23514';
  END IF;
  IF (NEW.checked_in_at, NEW.checked_in_by, NEW.checkin_key, NEW.checkin_hash) IS DISTINCT FROM (OLD.checked_in_at, OLD.checked_in_by, OLD.checkin_key, OLD.checkin_hash)
     AND NOT (OLD.status = 'reserved' AND NEW.status = 'in_house') THEN
    RAISE EXCEPTION 'Stay %: the check-in is recorded once, with it', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF (NEW.checked_out_at, NEW.checked_out_by, NEW.checkout_key, NEW.checkout_hash) IS DISTINCT FROM (OLD.checked_out_at, OLD.checked_out_by, OLD.checkout_key, OLD.checkout_hash)
     AND NOT (OLD.status = 'in_house' AND NEW.status = 'checked_out') THEN
    RAISE EXCEPTION 'Stay %: the check-out is recorded once, with it', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF (NEW.cancelled_at, NEW.cancelled_by, NEW.cancel_reason, NEW.cancel_key, NEW.cancel_hash) IS DISTINCT FROM
     (OLD.cancelled_at, OLD.cancelled_by, OLD.cancel_reason, OLD.cancel_key, OLD.cancel_hash) AND NEW.status NOT IN ('cancelled', 'no_show') THEN
    RAISE EXCEPTION 'Stay %: a cancellation is recorded when it is cancelled', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF NEW.document_id IS DISTINCT FROM OLD.document_id THEN
    IF OLD.document_id IS NOT NULL OR NEW.status = OLD.status THEN
      RAISE EXCEPTION 'Stay % is billed once: at check-out, or with a cancellation charge', OLD.stay_no USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id AND kind = 'sale'
       AND contact_id = CASE WHEN NEW.status = 'checked_out' THEN COALESCE(NEW.bill_to_contact_id, NEW.contact_id) ELSE NEW.contact_id END) THEN
      RAISE EXCEPTION 'Stay % is billed on a sale to its guest, or to the company it is billed to', OLD.stay_no USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION jewellery_schemes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kept TEXT[] := ARRAY['status', 'stop_reason', 'stopped_by', 'stop_approved_by', 'stopped_at', 'redeemed_document_id', 'redeemed_at', 'discount'];
  bill RECORD; paid INTEGER; today DATE; earned NUMERIC;
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A gold scheme is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - kept) <> (to_jsonb(OLD) - kept) THEN
    RAISE EXCEPTION 'Scheme % keeps what it was joined with', OLD.scheme_no USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status THEN
    IF (to_jsonb(NEW) - ARRAY['status']) <> (to_jsonb(OLD) - ARRAY['status']) THEN
      RAISE EXCEPTION 'Scheme % is % and keeps what it was', OLD.scheme_no, OLD.status USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'stopped' THEN
    IF OLD.status <> 'active' OR NEW.stopped_at <> now() OR NEW.redeemed_document_id IS NOT NULL THEN
      RAISE EXCEPTION 'Scheme % is stopped once, while it is active', OLD.scheme_no USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'redeemed' THEN
    IF OLD.status NOT IN ('active', 'stopped') OR NEW.redeemed_at <> now() OR (NEW.stopped_at IS DISTINCT FROM OLD.stopped_at) THEN
      RAISE EXCEPTION 'Scheme % is redeemed once', OLD.scheme_no USING ERRCODE = '23514';
    END IF;
    SELECT b.scheme_discount, b.created_at, d.contact_id INTO bill FROM jewellery_bills b JOIN business_documents d ON d.business_id = b.business_id AND d.id = b.document_id
    WHERE b.business_id = NEW.business_id AND b.document_id = NEW.redeemed_document_id AND b.scheme_id = NEW.id;
    IF NOT FOUND OR bill.created_at <> now() OR bill.contact_id <> NEW.contact_id THEN
      RAISE EXCEPTION 'Scheme % is redeemed on a jewellery bill of its member, made with it', OLD.scheme_no USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO paid FROM jewellery_scheme_instalments WHERE business_id = NEW.business_id AND scheme_id = NEW.id;
    today := (now() AT TIME ZONE (SELECT timezone FROM businesses WHERE id = NEW.business_id))::date;
    earned := CASE WHEN OLD.status = 'active' AND paid = NEW.instalments AND today >= NEW.maturity_on THEN round(NEW.instalment * NEW.discount_percent / 100, 2) ELSE 0 END;
    IF NEW.discount <> earned OR bill.scheme_discount <> earned THEN
      RAISE EXCEPTION 'Scheme %''s discount is ₹%: one instalment × the plan''s percentage, with every instalment paid, from its maturity', OLD.scheme_no, earned
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Scheme % cannot go from % to %', OLD.scheme_no, OLD.status, NEW.status USING ERRCODE = '23514';
END $$;

-- --- Who a person is: the same business ----------------------------------------------

-- A person named by a personal-data row belongs to that row's business: a
-- customer contact of it, or a guest of the restaurant behind it.
CREATE FUNCTION business_privacy_person(target_business BIGINT, contact BIGINT, guest BIGINT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF guest IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM customers c JOIN businesses b ON b.legacy_restaurant_id = c.restaurant_id
                   WHERE c.id = guest AND b.id = target_business) THEN
      RAISE EXCEPTION 'This guest belongs to another restaurant' USING ERRCODE = '23514';
    END IF;
  ELSIF contact IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM business_contacts WHERE business_id = target_business AND id = contact AND kind = 'customer') THEN
      RAISE EXCEPTION 'Personal data here is about a customer of this business' USING ERRCODE = '23514';
    END IF;
  END IF;
END $$;

-- Whether a person's data was erased at their request.
CREATE FUNCTION business_privacy_erased(target_business BIGINT, contact BIGINT, guest BIGINT) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN guest IS NOT NULL THEN EXISTS (SELECT 1 FROM customers WHERE id = guest AND erased_at IS NOT NULL)
              ELSE EXISTS (SELECT 1 FROM business_contacts WHERE business_id = target_business AND id = contact AND erased_at IS NOT NULL) END;
$$;

-- "Today" on the business's own clock: a restaurant's in its own time zone,
-- any other business's in its own.
CREATE FUNCTION business_privacy_today(target_business BIGINT) RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE COALESCE((SELECT s.timezone FROM restaurant_settings s WHERE s.restaurant_id = b.legacy_restaurant_id), b.timezone, 'Asia/Kolkata'))::date
  FROM businesses b WHERE b.id = target_business;
$$;

-- --- The privacy notice ------------------------------------------------------------

-- A business's notice in versions. The notice itself says, item by item, what
-- is collected and why, how to see, correct or erase it, how to complain and
-- whom to contact; each purpose has its own short consent notice; the privacy
-- contact is part of the version, as the notice names them.
CREATE TABLE business_privacy_notices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  notice TEXT NOT NULL CHECK (length(btrim(notice)) BETWEEN 200 AND 8000),
  bills_text VARCHAR(600) NOT NULL CHECK (length(btrim(bills_text)) >= 20),
  reminders_text VARCHAR(600) NOT NULL CHECK (length(btrim(reminders_text)) >= 20),
  offers_text VARCHAR(600) NOT NULL CHECK (length(btrim(offers_text)) >= 20),
  contact_name VARCHAR(150) NOT NULL CHECK (btrim(contact_name) <> ''),
  contact_phone VARCHAR(30),
  contact_email VARCHAR(150),
  published_by BIGINT NOT NULL REFERENCES users(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  UNIQUE (business_id, version),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  CONSTRAINT business_privacy_notices_contact CHECK (contact_phone IS NOT NULL OR contact_email IS NOT NULL)
);

CREATE FUNCTION business_privacy_notice_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A privacy notice is kept as it was published; publish a new version instead' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER business_privacy_notice_kept BEFORE UPDATE OR DELETE ON business_privacy_notices
  FOR EACH ROW EXECUTE FUNCTION business_privacy_notice_kept();

-- --- Consent per purpose: the clinic's consents become everyone's ---------------------

-- The clinic's patients' consents, with their rows and ids, become the
-- general record: the same row shape (purpose, the notice shown, how and by
-- whom it was given, who recorded it, its withdrawal once), now for any
-- customer of any business and any restaurant guest.
ALTER TABLE health_consents RENAME TO business_consents;
ALTER SEQUENCE health_consents_id_seq RENAME TO business_consents_id_seq;
ALTER INDEX health_consents_active RENAME TO business_consents_active;
ALTER TRIGGER health_consent_fixed ON business_consents RENAME TO business_consent_fixed;
ALTER FUNCTION health_consent_fixed() RENAME TO business_consent_fixed;

ALTER TABLE business_consents
  DROP CONSTRAINT health_consents_business_id_contact_id_fkey,
  DROP CONSTRAINT health_consents_purpose_check,
  DROP CONSTRAINT health_consents_method_check,
  DROP CONSTRAINT health_consents_given_by_check,
  ALTER COLUMN contact_id DROP NOT NULL,
  ALTER COLUMN notice_version DROP NOT NULL,
  ALTER COLUMN method DROP NOT NULL,
  ALTER COLUMN given_by DROP NOT NULL,
  ALTER COLUMN recorded_by DROP NOT NULL,
  -- A restaurant's guest.
  ADD COLUMN customer_id BIGINT REFERENCES customers(id),
  -- The version of the business's privacy notice shown (notice_version then
  -- says "v" and its number). Empty for a clinic's treatment and reports,
  -- given on the clinic's own consent notice (Clinic & lab settings), and for
  -- consent brought over from earlier records.
  ADD COLUMN notice_id BIGINT,
  -- Where it was given: at the counter, on the guests' site, on the phone,
  -- or brought over from earlier records (an import, the guest book's
  -- earlier consent box).
  ADD COLUMN channel TEXT NOT NULL DEFAULT 'counter',
  ADD COLUMN withdrawal_channel TEXT,
  ADD COLUMN note VARCHAR(300);
ALTER TABLE business_consents ALTER COLUMN channel DROP DEFAULT;
-- The clinic's withdrawals were taken at its front desk (the row stays as
-- given, so its guard waits while the new column is filled in).
ALTER TABLE business_consents DISABLE TRIGGER business_consent_fixed;
UPDATE business_consents SET withdrawal_channel = 'counter' WHERE withdrawn_at IS NOT NULL;
ALTER TABLE business_consents ENABLE TRIGGER business_consent_fixed;

ALTER TABLE business_consents
  ADD CONSTRAINT business_consents_purpose CHECK (purpose IN ('bills_digital', 'reminders', 'offers', 'treatment', 'reports_digital')),
  ADD CONSTRAINT business_consents_method CHECK (method IN ('signed_form', 'verbal', 'digital')),
  ADD CONSTRAINT business_consents_given_by CHECK (btrim(given_by) <> ''),
  ADD CONSTRAINT business_consents_channel CHECK (channel IN ('counter', 'guests_site', 'phone', 'import')),
  ADD CONSTRAINT business_consents_withdrawal_channel CHECK (withdrawal_channel IN ('counter', 'guests_site', 'phone')),
  ADD CONSTRAINT business_consents_one_person CHECK (num_nonnulls(contact_id, customer_id) = 1),
  ADD CONSTRAINT business_consents_contact_fkey FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  ADD CONSTRAINT business_consents_notice_fkey FOREIGN KEY (business_id, notice_id) REFERENCES business_privacy_notices(business_id, id),
  -- Every consent names the notice it was given on, but what came from earlier records.
  ADD CONSTRAINT business_consents_notice_shown CHECK (notice_version IS NOT NULL OR channel = 'import'),
  ADD CONSTRAINT business_consents_how CHECK (method IS NOT NULL OR channel = 'import'),
  -- Staff record it, but on the guests' site, where the guest does.
  ADD CONSTRAINT business_consents_recorder CHECK (recorded_by IS NOT NULL OR channel IN ('guests_site', 'import')),
  ADD CONSTRAINT business_consents_withdrawn CHECK ((withdrawn_at IS NULL) = (withdrawal_channel IS NULL)),
  -- Treatment and reports are a clinic patient's.
  ADD CONSTRAINT business_consents_patient CHECK (purpose NOT IN ('treatment', 'reports_digital') OR contact_id IS NOT NULL);

-- The constraints the clinic's table had keep their meaning under the new name.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'business_consents'::regclass AND conname LIKE 'health\_consents\_%' LOOP
    EXECUTE format('ALTER TABLE business_consents RENAME CONSTRAINT %I TO %I', c.conname, 'business_consents_' || substr(c.conname, length('health_consents_') + 1));
  END LOOP;
END $$;

-- One active consent per purpose and person (business_consents_active covers a contact's).
CREATE UNIQUE INDEX business_consents_guest_active ON business_consents(business_id, customer_id, purpose)
  WHERE withdrawn_at IS NULL AND customer_id IS NOT NULL;
CREATE INDEX business_consents_contact ON business_consents(business_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX business_consents_guest ON business_consents(customer_id) WHERE customer_id IS NOT NULL;

-- A consent is kept as given: never deleted, and only its withdrawal is
-- recorded, once. When two records of one guest are merged, the consent moves
-- to the record that stays, with nothing else changed.
CREATE OR REPLACE FUNCTION business_consent_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  open_fields CONSTANT TEXT[] := ARRAY['withdrawn_at', 'withdrawn_by', 'withdrawal_reason', 'withdrawal_channel', 'customer_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A consent record cannot be deleted; record its withdrawal' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - open_fields) <> (to_jsonb(OLD) - open_fields)
     OR (NEW.customer_id IS DISTINCT FROM OLD.customer_id AND (OLD.customer_id IS NULL OR NEW.customer_id IS NULL))
     OR (OLD.withdrawn_at IS NOT NULL AND (NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at OR NEW.withdrawn_by IS DISTINCT FROM OLD.withdrawn_by
       OR NEW.withdrawal_reason IS DISTINCT FROM OLD.withdrawal_reason OR NEW.withdrawal_channel IS DISTINCT FROM OLD.withdrawal_channel)) THEN
    RAISE EXCEPTION 'A consent is kept as given; only its withdrawal is recorded, once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- What a new consent may be: the business's own person, not erased; a
-- clinic's purposes only for its registered patients; never offers for a
-- child; the notice version named as the notice it points at.
CREATE FUNCTION business_consent_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  shown INTEGER;
BEGIN
  PERFORM business_privacy_person(NEW.business_id, NEW.contact_id, NEW.customer_id);
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;
  IF business_privacy_erased(NEW.business_id, NEW.contact_id, NEW.customer_id) THEN
    RAISE EXCEPTION 'This person''s data was erased at their request: no consent is recorded for them' USING ERRCODE = '23514';
  END IF;
  IF NEW.purpose IN ('treatment', 'reports_digital')
     AND NOT EXISTS (SELECT 1 FROM health_patients WHERE business_id = NEW.business_id AND contact_id = NEW.contact_id) THEN
    RAISE EXCEPTION 'Consent for treatment and for reports is given by a registered patient' USING ERRCODE = '23514';
  END IF;
  IF NEW.purpose = 'offers' AND NEW.withdrawn_at IS NULL AND EXISTS (SELECT 1 FROM business_children k WHERE k.business_id = NEW.business_id
       AND k.ended_at IS NULL AND (k.contact_id = NEW.contact_id OR k.customer_id = NEW.customer_id)) THEN
    RAISE EXCEPTION 'This person is marked as a child: offers are never sent to a child' USING ERRCODE = '23514';
  END IF;
  IF NEW.notice_id IS NOT NULL THEN
    SELECT version INTO shown FROM business_privacy_notices WHERE business_id = NEW.business_id AND id = NEW.notice_id;
    IF NEW.notice_version IS DISTINCT FROM 'v' || shown THEN
      RAISE EXCEPTION 'A consent names the version of the notice it was given on' USING ERRCODE = '23514';
    END IF;
  -- Without the privacy notice: only what came from earlier records, or what
  -- a clinic's patient gave on the clinic's own consent notice at its desk.
  ELSIF NEW.channel <> 'import' AND NOT (NEW.purpose IN ('treatment', 'reports_digital', 'reminders')
       AND EXISTS (SELECT 1 FROM health_patients WHERE business_id = NEW.business_id AND contact_id = NEW.contact_id)) THEN
    RAISE EXCEPTION 'A consent is given on the business''s privacy notice: publish it first (Settings › Personal data)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- --- A child -------------------------------------------------------------------------

-- A person marked as a child, with the parent or guardian whose consent stands
-- for theirs and how it was given. How the guardian is verified is recorded
-- as told (verified_how): the Rules' "verifiable" method is an open point.
CREATE TABLE business_children (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  contact_id BIGINT,
  customer_id BIGINT REFERENCES customers(id),
  guardian_name VARCHAR(150) NOT NULL CHECK (btrim(guardian_name) <> ''),
  guardian_relation VARCHAR(40) CHECK (btrim(guardian_relation) <> ''),
  consent_method TEXT NOT NULL CHECK (consent_method IN ('signed_form', 'verbal', 'digital')),
  verified_how VARCHAR(300) CHECK (btrim(verified_how) <> ''),
  marked_by BIGINT NOT NULL REFERENCES users(id),
  marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  ended_by BIGINT REFERENCES users(id),
  end_reason VARCHAR(300),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  CONSTRAINT business_children_one_person CHECK (num_nonnulls(contact_id, customer_id) = 1),
  CONSTRAINT business_children_ended CHECK ((ended_at IS NULL) = (ended_by IS NULL) AND (ended_at IS NULL) = (end_reason IS NULL))
);
CREATE UNIQUE INDEX business_children_contact ON business_children(business_id, contact_id) WHERE ended_at IS NULL AND contact_id IS NOT NULL;
CREATE UNIQUE INDEX business_children_guest ON business_children(business_id, customer_id) WHERE ended_at IS NULL AND customer_id IS NOT NULL;
CREATE INDEX business_children_guest_all ON business_children(customer_id) WHERE customer_id IS NOT NULL;

-- A mark is kept: never deleted, and only its end (grown up, or marked by
-- mistake) is recorded, once. A merge moves a guest's mark to the record that stays.
CREATE FUNCTION business_child_kept() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  open_fields CONSTANT TEXT[] := ARRAY['ended_at', 'ended_by', 'end_reason', 'customer_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A child''s mark is kept; record that it ended instead' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - open_fields) <> (to_jsonb(OLD) - open_fields)
     OR (NEW.customer_id IS DISTINCT FROM OLD.customer_id AND (OLD.customer_id IS NULL OR NEW.customer_id IS NULL))
     OR (OLD.ended_at IS NOT NULL AND (NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.ended_by IS DISTINCT FROM OLD.ended_by
       OR NEW.end_reason IS DISTINCT FROM OLD.end_reason)) THEN
    RAISE EXCEPTION 'A child''s mark is kept as recorded; only its end is recorded, once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_child_kept BEFORE UPDATE OR DELETE ON business_children
  FOR EACH ROW EXECUTE FUNCTION business_child_kept();

-- A mark is the business's own person's; while one is new, no consent to
-- offers may stand (it is withdrawn first).
CREATE FUNCTION business_child_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM business_privacy_person(NEW.business_id, NEW.contact_id, NEW.customer_id);
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM business_consents k WHERE k.business_id = NEW.business_id AND k.purpose = 'offers'
       AND k.withdrawn_at IS NULL AND (k.contact_id = NEW.contact_id OR k.customer_id = NEW.customer_id)) THEN
    RAISE EXCEPTION 'Withdraw this person''s consent to offers before marking them as a child: offers are never sent to a child' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_child_rules BEFORE INSERT OR UPDATE OF customer_id ON business_children
  FOR EACH ROW EXECUTE FUNCTION business_child_rules();

CREATE TRIGGER business_consent_rules BEFORE INSERT OR UPDATE OF customer_id ON business_consents
  FOR EACH ROW EXECUTE FUNCTION business_consent_rules();

-- --- The guest book's offers consent becomes a consent record --------------------------

-- Each guest who agreed to offers in the guest book keeps that consent, now
-- as a record: given when the guest book says, recorded by whoever ticked
-- the box, brought over from the guest book (no notice of the business's was
-- on file then).
INSERT INTO business_consents (business_id, customer_id, purpose, notice_version, channel, method, given_by, recorded_by, created_at, note)
SELECT restaurant_business_id(c.restaurant_id), c.id, 'offers', NULL, 'import', NULL, NULL, c.marketing_opt_in_by,
       COALESCE(c.marketing_opt_in_at, c.updated_at, c.created_at), 'Brought over from the guest book''s consent to offers'
FROM customers c
WHERE c.marketing_opt_in AND c.erased_at IS NULL
ORDER BY c.id;

-- The guest book's lists still filter and count on customers.marketing_opt_in
-- (and its _at, _by): from now on the database keeps them as a copy of the
-- guest's active consent to offers, and nothing else may write them.
CREATE FUNCTION business_consent_guest_copy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE customers c
  SET marketing_opt_in = (a.id IS NOT NULL), marketing_opt_in_at = a.created_at, marketing_opt_in_by = a.recorded_by
  FROM (SELECT guest FROM unnest(ARRAY[NEW.customer_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.customer_id END]) AS guest WHERE guest IS NOT NULL) g
  LEFT JOIN business_consents a ON a.customer_id = g.guest AND a.purpose = 'offers' AND a.withdrawn_at IS NULL
  WHERE c.id = g.guest
    AND (c.marketing_opt_in, c.marketing_opt_in_at, c.marketing_opt_in_by) IS DISTINCT FROM ((a.id IS NOT NULL), a.created_at, a.recorded_by);
  RETURN NULL;
END $$;
CREATE TRIGGER business_consent_guest_copy AFTER INSERT OR UPDATE ON business_consents
  FOR EACH ROW WHEN (NEW.purpose = 'offers' AND NEW.customer_id IS NOT NULL) EXECUTE FUNCTION business_consent_guest_copy();

CREATE FUNCTION customers_offers_consent_copy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() < 2 AND (
       (TG_OP = 'INSERT' AND (NEW.marketing_opt_in OR NEW.marketing_opt_in_at IS NOT NULL OR NEW.marketing_opt_in_by IS NOT NULL))
       OR (TG_OP = 'UPDATE' AND (NEW.marketing_opt_in, NEW.marketing_opt_in_at, NEW.marketing_opt_in_by)
           IS DISTINCT FROM (OLD.marketing_opt_in, OLD.marketing_opt_in_at, OLD.marketing_opt_in_by))) THEN
    RAISE EXCEPTION 'A guest''s consent to offers is recorded as a consent (Personal data), not on the guest''s record' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customers_offers_consent_copy BEFORE INSERT OR UPDATE OF marketing_opt_in, marketing_opt_in_at, marketing_opt_in_by ON customers
  FOR EACH ROW EXECUTE FUNCTION customers_offers_consent_copy();

-- --- A guests' site order's consents ----------------------------------------------------

-- What the guest ticked on the online ordering page, with the notice they
-- were shown: recorded against the guest the order is linked to when the
-- restaurant accepts it, never before (a rejected order leaves no record).
ALTER TABLE table_requests
  ADD COLUMN privacy_consents TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN privacy_notice_id BIGINT REFERENCES business_privacy_notices(id),
  ADD CONSTRAINT table_requests_privacy_consents CHECK (privacy_consents <@ ARRAY['bills_digital', 'offers']::TEXT[]
    AND (cardinality(privacy_consents) = 0 OR privacy_notice_id IS NOT NULL));

-- --- Requests from a person ------------------------------------------------------------

-- To see their data (access), correct it, erase it, or a grievance. Received
-- on the business's own day; answered within 90 days (due_on). An erasure is
-- carried out from its request (erased_at, and what was erased and kept in
-- erasure). A closed request is kept as the record.
CREATE TABLE business_privacy_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  request_no INTEGER NOT NULL CHECK (request_no >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('access', 'correction', 'erasure', 'grievance')),
  contact_id BIGINT,
  customer_id BIGINT REFERENCES customers(id),
  person_name VARCHAR(150) NOT NULL CHECK (btrim(person_name) <> ''),
  reply_to VARCHAR(150) CHECK (btrim(reply_to) <> ''),
  channel TEXT NOT NULL CHECK (channel IN ('counter', 'phone', 'email', 'letter')),
  details TEXT NOT NULL CHECK (length(btrim(details)) BETWEEN 3 AND 2000),
  received_on DATE NOT NULL,
  due_on DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'refused')),
  reply TEXT CHECK (length(btrim(reply)) BETWEEN 3 AND 2000),
  closed_at TIMESTAMPTZ,
  closed_by BIGINT REFERENCES users(id),
  erased_at TIMESTAMPTZ,
  erased_by BIGINT REFERENCES users(id),
  erasure JSONB,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_no),
  UNIQUE (business_id, request_key),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  CONSTRAINT business_privacy_requests_due CHECK (due_on = received_on + 90),
  CONSTRAINT business_privacy_requests_person CHECK (num_nonnulls(contact_id, customer_id) <= 1),
  CONSTRAINT business_privacy_requests_closed CHECK ((status = 'open') = (closed_at IS NULL) AND (closed_at IS NULL) = (closed_by IS NULL)
    AND (status = 'open' OR reply IS NOT NULL)),
  CONSTRAINT business_privacy_requests_erased CHECK ((erased_at IS NULL) = (erased_by IS NULL) AND (erased_at IS NULL) = (erasure IS NULL)
    AND (erased_at IS NULL OR (kind = 'erasure' AND num_nonnulls(contact_id, customer_id) = 1))),
  CONSTRAINT business_privacy_requests_erasure_done CHECK (kind <> 'erasure' OR status <> 'done' OR erased_at IS NOT NULL)
);
CREATE INDEX business_privacy_requests_open ON business_privacy_requests(business_id, due_on) WHERE status = 'open';
CREATE INDEX business_privacy_requests_guest ON business_privacy_requests(customer_id) WHERE customer_id IS NOT NULL;

-- A request is kept: never deleted; once closed, never changed. While open it
-- is linked to the person, answered, and an erasure carried out. Its person
-- is the business's own; the day received is not after the business's today.
CREATE FUNCTION business_privacy_request_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A request is kept as the record; close it with a reply instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'open' AND (to_jsonb(NEW) - 'customer_id') <> (to_jsonb(OLD) - 'customer_id') THEN
    RAISE EXCEPTION 'A closed request is kept as it was answered' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.kind, NEW.request_no, NEW.received_on, NEW.created_at, NEW.created_by, NEW.request_key)
       IS DISTINCT FROM (OLD.kind, OLD.request_no, OLD.received_on, OLD.created_at, OLD.created_by, OLD.request_key)
     OR TG_OP = 'UPDATE' AND OLD.erased_at IS NOT NULL AND (NEW.erased_at, NEW.erased_by, NEW.erasure, NEW.contact_id)
       IS DISTINCT FROM (OLD.erased_at, OLD.erased_by, OLD.erasure, OLD.contact_id) THEN
    RAISE EXCEPTION 'A request keeps when it came and what it asked; an erasure, once done, stays as done' USING ERRCODE = '23514';
  END IF;
  PERFORM business_privacy_person(NEW.business_id, NEW.contact_id, NEW.customer_id);
  IF TG_OP = 'INSERT' AND NEW.received_on > business_privacy_today(NEW.business_id) THEN
    RAISE EXCEPTION 'A request cannot be received on a day still to come' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_privacy_request_rules BEFORE INSERT OR UPDATE OR DELETE ON business_privacy_requests
  FOR EACH ROW EXECUTE FUNCTION business_privacy_request_rules();

-- --- The breach register ---------------------------------------------------------------

-- A personal-data breach: when it was found, what happened, its impact and the
-- steps taken; the Board's detailed report is due 72 hours after it was
-- found. The people affected are chosen (business_privacy_breach_people) or
-- every customer (affected = 'all'). people_notice is the plain-language
-- notice to them, filled from the record. Nothing is filed from here: the
-- business records when it told the Board and when it sent the report.
CREATE TABLE business_privacy_breaches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  breach_no INTEGER NOT NULL CHECK (breach_no >= 1),
  found_at TIMESTAMPTZ NOT NULL,
  what_happened TEXT NOT NULL CHECK (length(btrim(what_happened)) BETWEEN 10 AND 4000),
  impact TEXT NOT NULL CHECK (length(btrim(impact)) BETWEEN 3 AND 4000),
  steps_taken TEXT NOT NULL CHECK (length(btrim(steps_taken)) BETWEEN 3 AND 4000),
  affected TEXT NOT NULL CHECK (affected IN ('all', 'chosen')),
  people_notice TEXT CHECK (length(btrim(people_notice)) BETWEEN 50 AND 4000),
  board_informed_at TIMESTAMPTZ,
  board_report_at TIMESTAMPTZ,
  board_reference VARCHAR(100) CHECK (btrim(board_reference) <> ''),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at TIMESTAMPTZ,
  closed_by BIGINT REFERENCES users(id),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, breach_no),
  UNIQUE (business_id, request_key),
  CONSTRAINT business_privacy_breaches_closed CHECK ((status = 'open') = (closed_at IS NULL) AND (closed_at IS NULL) = (closed_by IS NULL)),
  CONSTRAINT business_privacy_breaches_board CHECK ((board_informed_at IS NULL OR board_informed_at >= found_at)
    AND (board_report_at IS NULL OR board_report_at >= found_at))
);

CREATE TABLE business_privacy_breach_people (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  breach_id BIGINT NOT NULL,
  contact_id BIGINT,
  customer_id BIGINT REFERENCES customers(id),
  added_by BIGINT NOT NULL REFERENCES users(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, breach_id) REFERENCES business_privacy_breaches(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  CONSTRAINT business_privacy_breach_people_one_person CHECK (num_nonnulls(contact_id, customer_id) = 1)
);
CREATE UNIQUE INDEX business_privacy_breach_people_contact ON business_privacy_breach_people(breach_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE UNIQUE INDEX business_privacy_breach_people_guest ON business_privacy_breach_people(breach_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX business_privacy_breach_people_guest_all ON business_privacy_breach_people(customer_id) WHERE customer_id IS NOT NULL;

-- Each notice sent to a person affected, as it was worded. Sent by the
-- business's own WhatsApp, SMS, e-mail, letter or in person, then recorded here.
CREATE TABLE business_privacy_breach_notices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  breach_id BIGINT NOT NULL,
  contact_id BIGINT,
  customer_id BIGINT REFERENCES customers(id),
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email', 'letter', 'in_person', 'phone')),
  notice_text TEXT NOT NULL CHECK (length(btrim(notice_text)) BETWEEN 50 AND 4000),
  sent_by BIGINT NOT NULL REFERENCES users(id),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  UNIQUE (business_id, request_key),
  FOREIGN KEY (business_id, breach_id) REFERENCES business_privacy_breaches(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  CONSTRAINT business_privacy_breach_notices_one_person CHECK (num_nonnulls(contact_id, customer_id) = 1)
);
CREATE INDEX business_privacy_breach_notices_breach ON business_privacy_breach_notices(business_id, breach_id);
CREATE INDEX business_privacy_breach_notices_guest ON business_privacy_breach_notices(customer_id) WHERE customer_id IS NOT NULL;

-- A breach is kept: never deleted; once closed, never changed. Its people
-- are the business's own; a person is taken off the list only while the
-- breach is open and before any notice went to them. A notice sent is kept
-- as sent. A merge moves a guest's rows to the record that stays.
CREATE FUNCTION business_privacy_breach_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A breach is kept as the record; close it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'A closed breach is kept as it was closed' USING ERRCODE = '23514';
  END IF;
  IF (NEW.breach_no, NEW.created_at, NEW.created_by, NEW.request_key) IS DISTINCT FROM (OLD.breach_no, OLD.created_at, OLD.created_by, OLD.request_key) THEN
    RAISE EXCEPTION 'A breach keeps its number and who recorded it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_privacy_breach_kept BEFORE UPDATE OR DELETE ON business_privacy_breaches
  FOR EACH ROW EXECUTE FUNCTION business_privacy_breach_kept();

CREATE FUNCTION business_privacy_breach_person() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_now RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_now := OLD;
  ELSE
    row_now := NEW;
  END IF;
  IF TG_TABLE_NAME = 'business_privacy_breach_notices' AND TG_OP <> 'INSERT'
     AND (TG_OP = 'DELETE' OR (to_jsonb(NEW) - 'customer_id') <> (to_jsonb(OLD) - 'customer_id')
          OR OLD.customer_id IS NULL OR NEW.customer_id IS NULL) THEN
    RAISE EXCEPTION 'A notice sent is kept as it was sent' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'business_privacy_breach_people' THEN
    IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - 'customer_id') <> (to_jsonb(OLD) - 'customer_id') OR OLD.customer_id IS NULL OR NEW.customer_id IS NULL) THEN
      RAISE EXCEPTION 'A person on a breach is added or taken off, not changed' USING ERRCODE = '23514';
    END IF;
    IF TG_OP <> 'UPDATE' AND EXISTS (SELECT 1 FROM business_privacy_breaches b WHERE b.business_id = row_now.business_id AND b.id = row_now.breach_id AND b.status <> 'open') THEN
      RAISE EXCEPTION 'A closed breach is kept as it was closed' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM business_privacy_breach_notices n WHERE n.business_id = OLD.business_id AND n.breach_id = OLD.breach_id
         AND (n.contact_id = OLD.contact_id OR n.customer_id = OLD.customer_id)) THEN
      RAISE EXCEPTION 'A notice went to this person, so they stay on the breach' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  PERFORM business_privacy_person(NEW.business_id, NEW.contact_id, NEW.customer_id);
  RETURN NEW;
END $$;
CREATE TRIGGER business_privacy_breach_people_rules BEFORE INSERT OR UPDATE OR DELETE ON business_privacy_breach_people
  FOR EACH ROW EXECUTE FUNCTION business_privacy_breach_person();
CREATE TRIGGER business_privacy_breach_notices_rules BEFORE INSERT OR UPDATE OR DELETE ON business_privacy_breach_notices
  FOR EACH ROW EXECUTE FUNCTION business_privacy_breach_person();

-- Down Migration
DROP TRIGGER business_privacy_breach_notices_rules ON business_privacy_breach_notices;
DROP TRIGGER business_privacy_breach_people_rules ON business_privacy_breach_people;
DROP FUNCTION business_privacy_breach_person();
DROP TRIGGER business_privacy_breach_kept ON business_privacy_breaches;
DROP FUNCTION business_privacy_breach_kept();
DROP TABLE business_privacy_breach_notices, business_privacy_breach_people, business_privacy_breaches;
DROP TRIGGER business_privacy_request_rules ON business_privacy_requests;
DROP FUNCTION business_privacy_request_rules();
DROP TABLE business_privacy_requests;

ALTER TABLE table_requests DROP CONSTRAINT table_requests_privacy_consents, DROP COLUMN privacy_notice_id, DROP COLUMN privacy_consents;

-- The guest book's offers consent goes back onto the guest's record, as the
-- consent records last had it (the copy already says so).
DROP TRIGGER customers_offers_consent_copy ON customers;
DROP FUNCTION customers_offers_consent_copy();
DROP TRIGGER business_consent_guest_copy ON business_consents;
DROP FUNCTION business_consent_guest_copy();

DROP TRIGGER business_consent_rules ON business_consents;
DROP FUNCTION business_consent_rules();
DROP TRIGGER business_child_rules ON business_children;
DROP FUNCTION business_child_rules();
DROP TRIGGER business_child_kept ON business_children;
DROP FUNCTION business_child_kept();
DROP TABLE business_children;

-- Only the clinic's patients' consents were kept in health_consents: the
-- others go, with the columns that held them.
ALTER TABLE business_consents DISABLE TRIGGER business_consent_fixed;
DELETE FROM business_consents WHERE customer_id IS NOT NULL OR purpose NOT IN ('treatment', 'reports_digital', 'reminders')
  OR NOT EXISTS (SELECT 1 FROM health_patients p WHERE p.business_id = business_consents.business_id AND p.contact_id = business_consents.contact_id);
UPDATE business_consents SET method = COALESCE(method, 'verbal'), given_by = COALESCE(given_by, 'The patient'), notice_version = COALESCE(notice_version, 'v1')
  WHERE method IS NULL OR given_by IS NULL OR notice_version IS NULL;
ALTER TABLE business_consents ENABLE TRIGGER business_consent_fixed;
DROP INDEX business_consents_guest;
DROP INDEX business_consents_contact;
DROP INDEX business_consents_guest_active;
ALTER TABLE business_consents
  DROP CONSTRAINT business_consents_patient,
  DROP CONSTRAINT business_consents_withdrawn,
  DROP CONSTRAINT business_consents_recorder,
  DROP CONSTRAINT business_consents_how,
  DROP CONSTRAINT business_consents_notice_shown,
  DROP CONSTRAINT business_consents_notice_fkey,
  DROP CONSTRAINT business_consents_contact_fkey,
  DROP CONSTRAINT business_consents_one_person,
  DROP CONSTRAINT business_consents_withdrawal_channel,
  DROP CONSTRAINT business_consents_channel,
  DROP CONSTRAINT business_consents_given_by,
  DROP CONSTRAINT business_consents_method,
  DROP CONSTRAINT business_consents_purpose,
  DROP COLUMN note,
  DROP COLUMN withdrawal_channel,
  DROP COLUMN channel,
  DROP COLUMN notice_id,
  DROP COLUMN customer_id;
-- The table and its constraints take their names back before the columns
-- are made required again, so those take the table's own name too.
ALTER TABLE business_consents RENAME TO health_consents;
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'health_consents'::regclass AND conname LIKE 'business\_consents\_%' LOOP
    EXECUTE format('ALTER TABLE health_consents RENAME CONSTRAINT %I TO %I', c.conname, 'health_consents_' || substr(c.conname, length('business_consents_') + 1));
  END LOOP;
END $$;
ALTER TABLE health_consents
  ALTER COLUMN contact_id SET NOT NULL,
  ALTER COLUMN notice_version SET NOT NULL,
  ALTER COLUMN method SET NOT NULL,
  ALTER COLUMN given_by SET NOT NULL,
  ALTER COLUMN recorded_by SET NOT NULL,
  ADD CONSTRAINT health_consents_business_id_contact_id_fkey FOREIGN KEY (business_id, contact_id) REFERENCES health_patients(business_id, contact_id),
  ADD CONSTRAINT health_consents_purpose_check CHECK (purpose IN ('treatment', 'reports_digital', 'reminders')),
  ADD CONSTRAINT health_consents_method_check CHECK (method IN ('signed_form', 'verbal', 'digital')),
  ADD CONSTRAINT health_consents_given_by_check CHECK (btrim(given_by) <> '');
ALTER INDEX business_consents_active RENAME TO health_consents_active;
ALTER SEQUENCE business_consents_id_seq RENAME TO health_consents_id_seq;
ALTER TRIGGER business_consent_fixed ON health_consents RENAME TO health_consent_fixed;
ALTER FUNCTION business_consent_fixed() RENAME TO health_consent_fixed;
CREATE OR REPLACE FUNCTION health_consent_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A consent record cannot be deleted; record its withdrawal' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['created_at', 'withdrawn_at', 'withdrawn_by', 'withdrawal_reason'])
     <> (to_jsonb(OLD) - ARRAY['created_at', 'withdrawn_at', 'withdrawn_by', 'withdrawal_reason'])
     OR (OLD.withdrawn_at IS NOT NULL AND (NEW.withdrawn_by IS DISTINCT FROM OLD.withdrawn_by OR NEW.withdrawal_reason IS DISTINCT FROM OLD.withdrawal_reason
       OR NEW.withdrawn_at IS NULL)) THEN
    RAISE EXCEPTION 'A consent is kept as given; only its withdrawal is recorded, once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER business_privacy_notice_kept ON business_privacy_notices;
DROP FUNCTION business_privacy_notice_kept();
DROP TABLE business_privacy_notices;
DROP FUNCTION business_privacy_today(BIGINT);
DROP FUNCTION business_privacy_erased(BIGINT, BIGINT, BIGINT);
DROP FUNCTION business_privacy_person(BIGINT, BIGINT, BIGINT);

-- The guards as they were.
CREATE OR REPLACE FUNCTION business_exchange_vouchers_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A credit voucher cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.used < OLD.used OR (to_jsonb(NEW) - ARRAY['used']) <> (to_jsonb(OLD) - ARRAY['used']) THEN
    RAISE EXCEPTION 'A credit voucher can only be spent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION business_quotations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE zone TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A quotation is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'Quotation % is % and can no longer change', OLD.quotation_no, OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.quotation_no <> OLD.quotation_no OR NEW.location_id <> OLD.location_id OR NEW.series_id IS DISTINCT FROM OLD.series_id
     OR NEW.request_key <> OLD.request_key OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A quotation keeps its number, its location and who made it' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision NOT IN (OLD.revision, OLD.revision + 1) THEN
    RAISE EXCEPTION 'A quotation is revised one step at a time' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('billed', 'ordered') THEN
    SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
    IF OLD.valid_until < (now() AT TIME ZONE zone)::date THEN
      RAISE EXCEPTION 'Quotation % was valid until %. Revise it to bring its prices up to date first.', OLD.quotation_no, to_char(OLD.valid_until, 'DD Mon YYYY')
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION books_customer_order_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A customer order cannot be deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.advance <> OLD.advance OR NEW.collection_id IS DISTINCT FROM OLD.collection_id
     OR NEW.request_key <> OLD.request_key OR NEW.order_no <> OLD.order_no
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id THEN
    RAISE EXCEPTION 'A customer order''s customer, advance and number are fixed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('collected', 'cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'This order is already closed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'arrived' AND NEW.status = 'ordered' THEN
    RAISE EXCEPTION 'An order that has arrived cannot go back to ordered' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION electronics_repair_jobs_closed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A repair job cannot be deleted; cancel it with a reason' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('delivered', 'cancelled') AND (to_jsonb(NEW) - 'created_at') <> (to_jsonb(OLD) - 'created_at') THEN
    RAISE EXCEPTION 'Repair job % is closed and cannot change', OLD.job_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION electronics_warranties_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A warranty cannot be deleted; cancel it with a reason' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'active' OR NEW.status <> 'cancelled'
       OR (to_jsonb(NEW) - ARRAY['status', 'cancel_reason', 'cancelled_by', 'cancelled_at', 'created_at'])
          <> (to_jsonb(OLD) - ARRAY['status', 'cancel_reason', 'cancelled_by', 'cancelled_at', 'created_at']) THEN
      RAISE EXCEPTION 'A registered warranty can only be cancelled' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM business_document_lines l JOIN business_documents d ON d.business_id = l.business_id AND d.id = l.document_id
                 WHERE l.business_id = NEW.business_id AND l.id = NEW.line_id AND l.document_id = NEW.document_id
                   AND d.kind = 'sale' AND l.sku_id = NEW.sku_id AND l.lot_code = NEW.serial) THEN
    RAISE EXCEPTION 'A warranty must match the sold line, item and serial number' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION salon_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Posted % rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'created_at') <> (to_jsonb(OLD) - 'created_at') THEN
    RAISE EXCEPTION 'Posted % rows cannot be changed', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION agri_farmers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A farmer''s details are never deleted; change them instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.contact_id <> OLD.contact_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A farmer''s details stay with the customer they were added for' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION hardware_sites_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A site is never deleted; close it instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.contact_id <> OLD.contact_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A site stays with the customer it was added for' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION garage_job_cards_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A job card is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Job card % is % and can no longer change', OLD.job_no, OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.job_no <> OLD.job_no OR NEW.location_id <> OLD.location_id OR NEW.series_id IS DISTINCT FROM OLD.series_id
     OR NEW.vehicle_id <> OLD.vehicle_id OR NEW.registration_no <> OLD.registration_no OR NEW.vehicle_name <> OLD.vehicle_name
     OR NEW.contact_id <> OLD.contact_id OR NEW.customer_name <> OLD.customer_name OR NEW.customer_phone IS DISTINCT FROM OLD.customer_phone
     OR NEW.odometer_in IS DISTINCT FROM OLD.odometer_in OR NEW.tax_mode <> OLD.tax_mode
     OR NEW.request_key <> OLD.request_key OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A job card keeps its number, vehicle, customer, odometer reading in and price terms' USING ERRCODE = '23514';
  END IF;
  IF OLD.advance_collection_id IS NOT NULL AND NEW.advance_collection_id IS DISTINCT FROM OLD.advance_collection_id THEN
    RAISE EXCEPTION 'A job card keeps the advance taken on it' USING ERRCODE = '23514';
  END IF;
  IF NEW.estimate_version NOT IN (OLD.estimate_version, OLD.estimate_version + 1) THEN
    RAISE EXCEPTION 'A job card''s estimate goes up one version at a time' USING ERRCODE = '23514';
  END IF;
  IF NEW.approved_version IS DISTINCT FROM OLD.approved_version AND NEW.approved_version IS DISTINCT FROM NEW.estimate_version THEN
    RAISE EXCEPTION 'An approval is of the estimate as it stands' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'received' AND NEW.status IN ('estimate_sent', 'approved', 'in_progress', 'waiting_parts', 'ready', 'cancelled'))
    OR (OLD.status = 'estimate_sent' AND NEW.status IN ('approved', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('estimate_sent', 'in_progress', 'waiting_parts', 'ready', 'cancelled'))
    OR (OLD.status IN ('in_progress', 'waiting_parts') AND NEW.status IN ('estimate_sent', 'in_progress', 'waiting_parts', 'ready', 'cancelled'))
    OR (OLD.status = 'ready' AND NEW.status IN ('estimate_sent', 'in_progress', 'waiting_parts', 'delivered', 'cancelled'))) THEN
    RAISE EXCEPTION 'Job card % cannot go from % to %', OLD.job_no, replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'approved' AND OLD.status <> 'approved' AND NEW.approved_version IS DISTINCT FROM NEW.estimate_version THEN
    RAISE EXCEPTION 'Job card % is approved once the owner approves the estimate as it stands', OLD.job_no USING ERRCODE = '23514';
  END IF;
  -- A job card with lines is delivered with its bill (or bills).
  IF NEW.status = 'delivered' AND NEW.document_id IS NULL AND NEW.insurer_document_id IS NULL
     AND EXISTS (SELECT 1 FROM garage_job_card_lines WHERE business_id = NEW.business_id AND job_card_id = NEW.id) THEN
    RAISE EXCEPTION 'Job card % is delivered with its bill', OLD.job_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION rental_bookings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE zone TEXT; unit RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A booking is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('returned', 'cancelled') THEN
    IF (to_jsonb(NEW) - ARRAY['updated_by', 'updated_at']) <> (to_jsonb(OLD) - ARRAY['updated_by', 'updated_at']) THEN
      RAISE EXCEPTION 'Booking % is % and no longer changes', OLD.booking_no, OLD.status USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.location_id <> OLD.location_id OR NEW.booking_no <> OLD.booking_no OR NEW.series_id IS DISTINCT FROM OLD.series_id OR NEW.contact_id <> OLD.contact_id
     OR NEW.customer_name <> OLD.customer_name OR NEW.customer_phone IS DISTINCT FROM OLD.customer_phone OR NEW.request_key <> OLD.request_key
     OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A booking keeps its number, its hirer and where it was made' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'quote' AND NEW.status IN ('reserved', 'cancelled'))
       OR (OLD.status = 'reserved' AND NEW.status IN ('out', 'cancelled')) OR (OLD.status = 'out' AND NEW.status = 'returned')) THEN
    RAISE EXCEPTION 'Booking % cannot go from % to %', OLD.booking_no, OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
  IF NEW.out_at <> OLD.out_at AND OLD.status NOT IN ('quote', 'reserved') THEN
    RAISE EXCEPTION 'Booking % is handed over: its out time stays as it was', OLD.booking_no USING ERRCODE = '23514';
  END IF;
  IF (NEW.out_at <> OLD.out_at OR (OLD.status = 'quote' AND NEW.status = 'reserved'))
     AND NEW.out_at < (date_trunc('day', now() AT TIME ZONE zone) AT TIME ZONE zone) THEN
    RAISE EXCEPTION 'Booking % would start on a day that has passed: give it times today or later', OLD.booking_no USING ERRCODE = '23514';
  END IF;
  IF (NEW.checked_out_at, NEW.checked_out_by, NEW.checkout_key, NEW.checkout_hash, NEW.id_kind, NEW.id_ref, NEW.licence_no, NEW.licence_valid_until,
      NEW.deposit_waived_by, NEW.deposit_waiver) IS DISTINCT FROM (OLD.checked_out_at, OLD.checked_out_by, OLD.checkout_key, OLD.checkout_hash, OLD.id_kind,
      OLD.id_ref, OLD.licence_no, OLD.licence_valid_until, OLD.deposit_waived_by, OLD.deposit_waiver)
     AND NOT (OLD.status = 'reserved' AND NEW.status = 'out') THEN
    RAISE EXCEPTION 'Booking %: what was recorded at the handover stays as it was', OLD.booking_no USING ERRCODE = '23514';
  END IF;
  IF NEW.returned_at IS DISTINCT FROM OLD.returned_at AND NOT (OLD.status = 'out' AND NEW.status = 'returned') THEN
    RAISE EXCEPTION 'Booking % is back when the last of it is returned', OLD.booking_no USING ERRCODE = '23514';
  END IF;
  IF (NEW.cancelled_at, NEW.cancelled_by, NEW.cancel_reason, NEW.cancel_key, NEW.cancel_hash) IS DISTINCT FROM
     (OLD.cancelled_at, OLD.cancelled_by, OLD.cancel_reason, OLD.cancel_key, OLD.cancel_hash) AND NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION 'Booking %: a cancellation is recorded when it is cancelled', OLD.booking_no USING ERRCODE = '23514';
  END IF;
  IF NEW.document_id IS DISTINCT FROM OLD.document_id THEN
    IF OLD.document_id IS NOT NULL OR NEW.status = OLD.status THEN
      RAISE EXCEPTION 'Booking % is billed once: when the last of it is back, or with a cancellation charge', OLD.booking_no USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id AND kind = 'sale' AND contact_id = NEW.contact_id) THEN
      RAISE EXCEPTION 'Booking % is billed on a sale to its hirer', OLD.booking_no USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.status = 'reserved' AND NEW.status = 'out' THEN
    SELECT u.label, u.status INTO unit FROM rental_booking_lines l JOIN rental_units u ON u.business_id = l.business_id AND u.id = l.unit_id
    WHERE l.business_id = NEW.business_id AND l.booking_id = NEW.id AND u.status <> 'available' ORDER BY l.seq LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION '% is % and is not handed over', unit.label, CASE unit.status WHEN 'maintenance' THEN 'in maintenance' ELSE 'retired' END USING ERRCODE = '23514';
    END IF;
    IF rental_deposit_held(NEW.business_id, NEW.id) < NEW.deposit_due AND NEW.deposit_waiver IS NULL THEN
      RAISE EXCEPTION 'Booking % asks a deposit of %: take the rest, or record who agreed to less', OLD.booking_no, NEW.deposit_due USING ERRCODE = '23514';
    END IF;
    IF NEW.licence_valid_until IS NOT NULL AND NEW.licence_valid_until < (now() AT TIME ZONE zone)::date THEN
      RAISE EXCEPTION 'The driving licence % ran out on %: a vehicle is not handed over on it', NEW.licence_no, to_char(NEW.licence_valid_until, 'FMDD Mon YYYY')
        USING ERRCODE = '23514';
    END IF;
    IF NEW.licence_no IS NULL AND EXISTS (SELECT 1 FROM rental_booking_lines l JOIN rental_items i ON i.business_id = l.business_id AND i.id = l.item_id
       WHERE l.business_id = NEW.business_id AND l.booking_id = NEW.id AND i.vehicle IS NOT NULL AND NOT i.with_driver) THEN
      RAISE EXCEPTION 'A self-drive vehicle is handed over with the hirer''s driving licence number and expiry' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION laundry_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A garment order is never deleted; cancel its garments instead' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['promised_on', 'notes', 'updated_by', 'updated_at']) <> (to_jsonb(OLD) - ARRAY['promised_on', 'notes', 'updated_by', 'updated_at']) THEN
    RAISE EXCEPTION 'A garment order keeps its number, customer, rules, prices and terms as it was taken in' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION optical_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A spectacle order is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Spectacle order % is % and can no longer change', OLD.order_no, OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.order_no <> OLD.order_no OR NEW.location_id <> OLD.location_id OR NEW.series_id IS DISTINCT FROM OLD.series_id
     OR NEW.contact_id <> OLD.contact_id OR NEW.prescription_id <> OLD.prescription_id OR NEW.rx <> OLD.rx
     OR NEW.tax_mode <> OLD.tax_mode OR NEW.subtotal <> OLD.subtotal OR NEW.tax <> OLD.tax OR NEW.round_off <> OLD.round_off
     OR NEW.total <> OLD.total OR NEW.savings <> OLD.savings OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
     OR NEW.discount_percent IS DISTINCT FROM OLD.discount_percent OR NEW.discount_reason IS DISTINCT FROM OLD.discount_reason
     OR NEW.remake_of IS DISTINCT FROM OLD.remake_of OR NEW.remake_reason IS DISTINCT FROM OLD.remake_reason
     OR NEW.remake_cost_by IS DISTINCT FROM OLD.remake_cost_by OR NEW.advance_collection_id IS DISTINCT FROM OLD.advance_collection_id
     OR NEW.request_key <> OLD.request_key OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A spectacle order keeps its number, customer, prescription, prices and advance' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'booked' AND NEW.status IN ('at_lab', 'in_workshop', 'cancelled'))
    OR (OLD.status = 'at_lab' AND NEW.status IN ('in_workshop', 'quality_check', 'cancelled'))
    OR (OLD.status = 'in_workshop' AND NEW.status IN ('at_lab', 'quality_check', 'cancelled'))
    OR (OLD.status = 'quality_check' AND NEW.status IN ('ready', 'at_lab', 'in_workshop', 'cancelled'))
    OR (OLD.status = 'ready' AND NEW.status IN ('at_lab', 'in_workshop', 'delivered', 'cancelled'))) THEN
    RAISE EXCEPTION 'Spectacle order % cannot go from % to %', OLD.order_no, replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = '23514';
  END IF;
  -- Ready only after passing the quality check, which is then stamped.
  IF NEW.status = 'ready' AND OLD.status <> 'ready' AND (NEW.checked_at IS NOT DISTINCT FROM OLD.checked_at) THEN
    RAISE EXCEPTION 'Spectacle order % is ready only once it passes the quality check', OLD.order_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION lodging_stays_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE today DATE; room RECORD; last_night DATE; done TEXT; check_room BOOLEAN; moving_in BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A stay is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  today := lodging_today(NEW.business_id);
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('checked_out', 'cancelled', 'no_show') THEN
      IF (to_jsonb(NEW) - ARRAY['updated_by', 'updated_at']) <> (to_jsonb(OLD) - ARRAY['updated_by', 'updated_at']) THEN
        done := CASE OLD.status WHEN 'checked_out' THEN 'checked out' WHEN 'cancelled' THEN 'cancelled' ELSE 'a no-show' END;
        RAISE EXCEPTION 'Stay % is % and no longer changes', OLD.stay_no, done USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    check_room := NEW.room_id IS NOT NULL AND (NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.room_type_id <> OLD.room_type_id OR NEW.status <> OLD.status);
    moving_in := NEW.status = 'in_house' AND (OLD.status <> 'in_house' OR NEW.room_id IS DISTINCT FROM OLD.room_id);
  ELSE
    check_room := NEW.room_id IS NOT NULL;
  END IF;
  -- The room it takes, whenever one is given, changed, or checked in to.
  IF check_room THEN
    SELECT room_no, location_id, room_type_id, status, status_note, active INTO room FROM lodging_rooms WHERE business_id = NEW.business_id AND id = NEW.room_id;
    IF NOT room.active THEN
      RAISE EXCEPTION 'Room % is out of use', room.room_no USING ERRCODE = '23514';
    END IF;
    IF room.location_id <> NEW.location_id THEN
      RAISE EXCEPTION 'Room % is at another location', room.room_no USING ERRCODE = '23514';
    END IF;
    IF room.room_type_id <> NEW.room_type_id THEN
      RAISE EXCEPTION 'Room % is of another room type: change the stay''s room type with the room', room.room_no USING ERRCODE = '23514';
    END IF;
    IF moving_in AND room.status <> 'vacant_clean' THEN
      RAISE EXCEPTION 'Room % is %: a guest checks in to a room that is vacant and clean', room.room_no,
        CASE room.status WHEN 'vacant_dirty' THEN 'not made up yet' WHEN 'occupied' THEN 'occupied' ELSE 'out of order (' || room.status_note || ')' END USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.location_id <> OLD.location_id OR NEW.stay_no <> OLD.stay_no OR NEW.series_id IS DISTINCT FROM OLD.series_id OR NEW.contact_id <> OLD.contact_id
     OR NEW.guest_name <> OLD.guest_name OR NEW.guest_phone IS DISTINCT FROM OLD.guest_phone OR NEW.request_key <> OLD.request_key
     OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A stay keeps its number, its guest and where it was made' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'reserved' AND NEW.status IN ('in_house', 'cancelled', 'no_show')) OR (OLD.status = 'in_house' AND NEW.status = 'checked_out')) THEN
    RAISE EXCEPTION 'Stay % cannot go from % to %', OLD.stay_no, replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = '23514';
  END IF;
  IF NEW.arrival <> OLD.arrival AND (OLD.status <> 'reserved' OR NEW.status <> 'reserved') THEN
    RAISE EXCEPTION 'Stay % has arrived: its arrival stays as it was', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF NEW.arrival <> OLD.arrival AND NEW.arrival < today THEN
    RAISE EXCEPTION 'Stay % would arrive on a day that has passed: give it dates from today', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'reserved' AND NEW.status = 'in_house' AND (today < NEW.arrival OR today >= NEW.departure) THEN
    RAISE EXCEPTION 'Stay % is for the nights of % to %: a guest checks in from the arrival day to the night before the departure', OLD.stay_no,
      lodging_day_words(NEW.arrival), lodging_day_words(NEW.departure - 1) USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'in_house' AND NEW.room_id IS NULL THEN
    RAISE EXCEPTION 'Stay % has a guest in the house: they keep a room', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'in_house' AND (NEW.adults <> OLD.adults OR NEW.children <> OLD.children) THEN
    RAISE EXCEPTION 'Stay %: the adults and children are the occupants recorded at check-in', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF NEW.departure <> OLD.departure AND OLD.status = 'in_house' THEN
    SELECT max(night) INTO last_night FROM lodging_charges WHERE business_id = NEW.business_id AND stay_id = NEW.id AND kind = 'room_night' AND voided_at IS NULL;
    IF last_night IS NOT NULL AND NEW.departure <= last_night THEN
      RAISE EXCEPTION 'Stay %: the night of % is posted already, so the guest leaves on % or later', OLD.stay_no, lodging_day_words(last_night),
        lodging_day_words(last_night + 1) USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'in_house' AND NEW.departure < today THEN
      RAISE EXCEPTION 'Stay % has a guest in the house: they leave today or later', OLD.stay_no USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.status = 'in_house' AND NEW.status = 'checked_out' AND NEW.departure <> GREATEST(today, NEW.arrival + 1) THEN
    RAISE EXCEPTION 'Stay % was to leave on %: extend it to today first', OLD.stay_no, lodging_day_words(OLD.departure) USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'reserved' AND NEW.status = 'no_show' AND today < NEW.arrival THEN
    RAISE EXCEPTION 'Stay % arrives on %: a guest is a no-show once the arrival day has come; cancel it instead', OLD.stay_no, lodging_day_words(NEW.arrival) USING ERRCODE = '23514';
  END IF;
  IF (NEW.checked_in_at, NEW.checked_in_by, NEW.checkin_key, NEW.checkin_hash) IS DISTINCT FROM (OLD.checked_in_at, OLD.checked_in_by, OLD.checkin_key, OLD.checkin_hash)
     AND NOT (OLD.status = 'reserved' AND NEW.status = 'in_house') THEN
    RAISE EXCEPTION 'Stay %: the check-in is recorded once, with it', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF (NEW.checked_out_at, NEW.checked_out_by, NEW.checkout_key, NEW.checkout_hash) IS DISTINCT FROM (OLD.checked_out_at, OLD.checked_out_by, OLD.checkout_key, OLD.checkout_hash)
     AND NOT (OLD.status = 'in_house' AND NEW.status = 'checked_out') THEN
    RAISE EXCEPTION 'Stay %: the check-out is recorded once, with it', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF (NEW.cancelled_at, NEW.cancelled_by, NEW.cancel_reason, NEW.cancel_key, NEW.cancel_hash) IS DISTINCT FROM
     (OLD.cancelled_at, OLD.cancelled_by, OLD.cancel_reason, OLD.cancel_key, OLD.cancel_hash) AND NEW.status NOT IN ('cancelled', 'no_show') THEN
    RAISE EXCEPTION 'Stay %: a cancellation is recorded when it is cancelled', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF NEW.document_id IS DISTINCT FROM OLD.document_id THEN
    IF OLD.document_id IS NOT NULL OR NEW.status = OLD.status THEN
      RAISE EXCEPTION 'Stay % is billed once: at check-out, or with a cancellation charge', OLD.stay_no USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id AND kind = 'sale'
       AND contact_id = CASE WHEN NEW.status = 'checked_out' THEN COALESCE(NEW.bill_to_contact_id, NEW.contact_id) ELSE NEW.contact_id END) THEN
      RAISE EXCEPTION 'Stay % is billed on a sale to its guest, or to the company it is billed to', OLD.stay_no USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION jewellery_schemes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kept TEXT[] := ARRAY['status', 'stop_reason', 'stopped_by', 'stop_approved_by', 'stopped_at', 'redeemed_document_id', 'redeemed_at', 'discount'];
  bill RECORD; paid INTEGER; today DATE; earned NUMERIC;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A gold scheme is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - kept) <> (to_jsonb(OLD) - kept) THEN
    RAISE EXCEPTION 'Scheme % keeps what it was joined with', OLD.scheme_no USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status THEN
    IF (to_jsonb(NEW) - ARRAY['status']) <> (to_jsonb(OLD) - ARRAY['status']) THEN
      RAISE EXCEPTION 'Scheme % is % and keeps what it was', OLD.scheme_no, OLD.status USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'stopped' THEN
    IF OLD.status <> 'active' OR NEW.stopped_at <> now() OR NEW.redeemed_document_id IS NOT NULL THEN
      RAISE EXCEPTION 'Scheme % is stopped once, while it is active', OLD.scheme_no USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'redeemed' THEN
    IF OLD.status NOT IN ('active', 'stopped') OR NEW.redeemed_at <> now() OR (NEW.stopped_at IS DISTINCT FROM OLD.stopped_at) THEN
      RAISE EXCEPTION 'Scheme % is redeemed once', OLD.scheme_no USING ERRCODE = '23514';
    END IF;
    SELECT b.scheme_discount, b.created_at, d.contact_id INTO bill FROM jewellery_bills b JOIN business_documents d ON d.business_id = b.business_id AND d.id = b.document_id
    WHERE b.business_id = NEW.business_id AND b.document_id = NEW.redeemed_document_id AND b.scheme_id = NEW.id;
    IF NOT FOUND OR bill.created_at <> now() OR bill.contact_id <> NEW.contact_id THEN
      RAISE EXCEPTION 'Scheme % is redeemed on a jewellery bill of its member, made with it', OLD.scheme_no USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO paid FROM jewellery_scheme_instalments WHERE business_id = NEW.business_id AND scheme_id = NEW.id;
    today := (now() AT TIME ZONE (SELECT timezone FROM businesses WHERE id = NEW.business_id))::date;
    earned := CASE WHEN OLD.status = 'active' AND paid = NEW.instalments AND today >= NEW.maturity_on THEN round(NEW.instalment * NEW.discount_percent / 100, 2) ELSE 0 END;
    IF NEW.discount <> earned OR bill.scheme_discount <> earned THEN
      RAISE EXCEPTION 'Scheme %''s discount is ₹%: one instalment × the plan''s percentage, with every instalment paid, from its maturity', OLD.scheme_no, earned
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Scheme % cannot go from % to %', OLD.scheme_no, OLD.status, NEW.status USING ERRCODE = '23514';
END $$;
DROP FUNCTION business_privacy_erasing(TEXT, JSONB, JSONB);

-- Repairs and warranties need a phone again; one taken without it stops the way back.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM electronics_repair_jobs WHERE customer_phone IS NULL OR phone_digits IS NULL)
     OR EXISTS (SELECT 1 FROM electronics_warranties WHERE customer_phone IS NULL OR phone_digits IS NULL) THEN
    RAISE EXCEPTION 'Repair jobs or warranties without a phone exist: they cannot need one again';
  END IF;
END $$;
ALTER TABLE electronics_warranties ALTER COLUMN customer_phone SET NOT NULL, ALTER COLUMN phone_digits SET NOT NULL;
ALTER TABLE electronics_repair_jobs ALTER COLUMN customer_phone SET NOT NULL, ALTER COLUMN phone_digits SET NOT NULL;

ALTER TABLE business_contacts DROP CONSTRAINT business_contacts_erased, DROP COLUMN erased_by, DROP COLUMN erased_at;

DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE module = 'privacy');
DELETE FROM permissions WHERE module = 'privacy';
DELETE FROM business_role_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'privacy');
DELETE FROM business_role_template_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'privacy');
DELETE FROM business_permissions WHERE module_code = 'privacy';
DELETE FROM platform_modules WHERE code = 'privacy';
