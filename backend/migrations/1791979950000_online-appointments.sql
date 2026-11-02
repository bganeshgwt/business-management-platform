-- Up Migration
-- Online booking (module "online_appointments", sold as an application): a
-- booking link per location of a salon, clinic, optical shop, garage, gym or
-- electronics shop, where a guest books a slot on the guests' site
-- (/appointments/<token>) with no login, and follows it on a status page of
-- their own (/appointments/status/<guest token>).
--
-- One booking engine: an online booking is a business_appointments row, made
-- through the same rules as the desk's (a salon's service times, skills,
-- stylists' weeks, leave, holidays and rooms; a clinic's OPD sessions, slot
-- length and leave; anyone else's opening hours), under the same locks, and
-- the same clash check, so the desk and the guests can never book one person
-- twice.
--
--   business_booking_links       one booking link per location: its opaque
--                                token (192 random bits; replaced to kill an
--                                old QR), switched on or off, and its rules:
--                                instant or confirm, how many days ahead, the
--                                notice, the step between times, the cut-off
--                                for a guest's own cancel or change and how
--                                many changes, open bookings per mobile,
--                                prices shown, "any stylist", no-shows that
--                                turn a booking into a request, how long a
--                                request waits, a clinic session's online
--                                share, a salon's optional UPI advance (and
--                                the UPI id it is paid to), and a note for
--                                guests.
--   business_booking_link_services
--   business_booking_link_people what shows online, where the owner changed
--                                it: a salon's timed services and every
--                                stylist, a clinic's doctors with OPD timings
--                                and a fee, anyone else's people show unless
--                                hidden; anyone else's services show once
--                                given their length here.
--   business_online_bookings     each guest's booking: its guest token and the
--                                guest's clientKey, the customer found or made
--                                for the booker's mobile, who it is for (a
--                                patient's age and sex, new or follow-up, the
--                                reason; a vehicle's number, make and model),
--                                the guest's note, the consents ticked on the
--                                notice shown, the salon's age declaration, a
--                                UPI advance and its UTR, why it waits for the
--                                desk, the desk's answer and the guest's own
--                                changes. Its appointments (a salon's one to
--                                three services back to back) point at it.
--
-- business_appointments gains:
--   status 'requested'           a request the desk accepts or declines; it
--                                holds its time until it is answered, it
--                                expires (request_expires_at: the link's hours
--                                from the request, never past its start) or
--                                its start passes
--   status 'declined'            the desk said no (the reason on the booking)
--   status 'expired'             nobody answered in time (made on read, with an
--                                audit row of channel 'automatic')
--   source                       'staff' (every booking before this) or
--                                'guests_site'; created_by is empty exactly on a
--                                guest's row
--   online_booking_id            the guest's booking it belongs to
-- business_appointment_holds(status, expires) is what every reader asks of
-- a row: does it hold its time? A booking does; a request does until it is
-- answered or expires; declined, expired, cancelled, done and no-show rows
-- do not.
--
-- A clinic doctor's profile gains the qualifications, registration number and
-- medical council guests see before booking (IMC Regulations 2002, 1.4.1 and
-- 1.8); a gym's enquiry made from the guests' site (source 'website') has no
-- one who made it; and a salon's online booking takes its deposit once, when
-- the desk accepts it (salon_appointment_details_fixed, replaced from
-- 1791600000000).

-- --- The module, its permissions and roles --------------------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('online_appointments', 'Online booking', 'A booking link for each location: guests book a salon visit, a doctor''s OPD slot, an eye test, a vehicle service or a free trial themselves, at once or as a request the desk accepts, and follow it live; the desk answers requests and sees online bookings on its calendar.', 'optional', 231);

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES ('online_appointments', 'appointments');

INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default, recommended, recommended_note) VALUES
 ('online_appointments', 'salon', FALSE, FALSE, NULL),
 ('online_appointments', 'healthcare', FALSE, TRUE, 'Patients book an OPD slot from the clinic''s link; walk-ins keep their share of each session.'),
 ('online_appointments', 'optical', FALSE, FALSE, NULL),
 ('online_appointments', 'garage', FALSE, FALSE, NULL),
 ('online_appointments', 'memberships', FALSE, FALSE, NULL),
 ('online_appointments', 'electronics', FALSE, FALSE, NULL);

INSERT INTO platform_module_prices (module_code, sold_as, monthly_price, yearly_price) VALUES ('online_appointments', 'application', 299, 2999);

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('online_appointments', 'view', 'See online bookings, the requests waiting and the booking link', 96),
 ('online_appointments', 'approve', 'Accept or decline online booking requests', 97),
 ('online_appointments', 'manage', 'Set up online booking: the link, its rules and what shows online', 98)
) AS p(module_code, action, name, sort_order);

-- The front desk answers requests; the people booked (doctors, optometrists,
-- trainers, mechanics) see what came in online.
INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code = 'online_appointments'
UNION ALL SELECT 'cashier', unnest(ARRAY['online_appointments.view', 'online_appointments.approve'])
UNION ALL SELECT 'accountant', unnest(ARRAY['online_appointments.view'])
UNION ALL SELECT 'viewer', unnest(ARRAY['online_appointments.view'])
UNION ALL SELECT 'doctor', unnest(ARRAY['online_appointments.view'])
UNION ALL SELECT 'optometrist', unnest(ARRAY['online_appointments.view', 'online_appointments.approve'])
UNION ALL SELECT 'trainer', unnest(ARRAY['online_appointments.view'])
UNION ALL SELECT 'mechanic', unnest(ARRAY['online_appointments.view']);

-- Existing businesses' copies of those templates (harmless where the module
-- cannot be switched on; keeps "role copy = template").
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code = 'online_appointments'
WHERE NOT r.full_access
ON CONFLICT DO NOTHING;

-- --- Booking links -----------------------------------------------------------------------------------

CREATE TABLE business_booking_links (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  -- The link's key (/appointments/<token>). Replacing it kills every printed
  -- QR and shared copy of the old link on purpose.
  token VARCHAR(64) NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{32,64}$'),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- instant: a free time is booked at once; confirm: a request the desk
  -- accepts or declines (a clinic's default).
  confirm_mode TEXT NOT NULL DEFAULT 'instant' CHECK (confirm_mode IN ('instant', 'confirm')),
  -- How many days guests see, today included.
  days_ahead SMALLINT NOT NULL DEFAULT 30 CHECK (days_ahead BETWEEN 1 AND 90),
  min_notice_minutes SMALLINT NOT NULL DEFAULT 120 CHECK (min_notice_minutes BETWEEN 0 AND 2880),
  slot_step_minutes SMALLINT NOT NULL DEFAULT 15 CHECK (slot_step_minutes IN (10, 15, 20, 30, 60)),
  -- A guest cancels or changes online until this many hours before the start.
  cancel_hours SMALLINT NOT NULL DEFAULT 3 CHECK (cancel_hours BETWEEN 0 AND 168),
  max_changes SMALLINT NOT NULL DEFAULT 2 CHECK (max_changes BETWEEN 0 AND 5),
  max_open_per_mobile SMALLINT NOT NULL DEFAULT 3 CHECK (max_open_per_mobile BETWEEN 1 AND 10),
  show_prices BOOLEAN NOT NULL DEFAULT TRUE,
  -- "Any stylist" (any doctor, bay, trainer): the free one with the fewest bookings that day.
  allow_any_staff BOOLEAN NOT NULL DEFAULT TRUE,
  -- A mobile with this many no-shows in 90 days books as a request even in
  -- instant mode (0: never).
  confirm_after_no_shows SMALLINT NOT NULL DEFAULT 2 CHECK (confirm_after_no_shows BETWEEN 0 AND 10),
  request_expiry_hours SMALLINT NOT NULL DEFAULT 12 CHECK (request_expiry_hours BETWEEN 1 AND 72),
  -- A clinic: online bookings in one OPD session at most this share of its
  -- patients (or of its slots, when it has no cap), so walk-ins keep room.
  online_share_percent SMALLINT NOT NULL DEFAULT 50 CHECK (online_share_percent BETWEEN 10 AND 100),
  -- A salon that takes deposits: the guest pays the advance to this UPI id and
  -- types the payment's 12-digit UTR; the desk checks it and accepts.
  upi_advance BOOLEAN NOT NULL DEFAULT FALSE,
  upi_id VARCHAR(100) CHECK (upi_id IS NULL OR upi_id ~ '^[A-Za-z0-9._-]{2,100}@[A-Za-z][A-Za-z0-9.-]{1,63}$'),
  upi_payee VARCHAR(100),
  guest_note VARCHAR(300),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, location_id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  CHECK (NOT upi_advance OR upi_id IS NOT NULL)
);

-- What shows online, where the owner chose. No row: a salon's timed service
-- shows, anyone else's service does not (it needs its length here); a
-- person shows.
CREATE TABLE business_booking_link_services (
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  link_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  shown BOOLEAN NOT NULL,
  -- The length booked online (a salon's comes from its service times).
  minutes SMALLINT CHECK (minutes BETWEEN 5 AND 480),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (link_id, sku_id),
  FOREIGN KEY (business_id, link_id) REFERENCES business_booking_links(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id)
);
CREATE TABLE business_booking_link_people (
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  link_id BIGINT NOT NULL,
  resource_id BIGINT NOT NULL,
  shown BOOLEAN NOT NULL,
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (link_id, resource_id),
  FOREIGN KEY (business_id, link_id) REFERENCES business_booking_links(business_id, id),
  FOREIGN KEY (business_id, resource_id) REFERENCES business_resources(business_id, id)
);

-- --- A guest's booking -------------------------------------------------------------------------------

CREATE TABLE business_online_bookings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  link_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  -- The guest's own link to it (/appointments/status/<guest token>).
  guest_token VARCHAR(64) NOT NULL UNIQUE CHECK (guest_token ~ '^[A-Za-z0-9_-]{32,64}$'),
  -- The page's key for this submission: a double tap or a retry is the same
  -- booking; the same key with other details is refused.
  client_key VARCHAR(64) NOT NULL CHECK (client_key ~ '^[A-Za-z0-9-]{8,64}$'),
  request_hash CHAR(64) NOT NULL,
  -- The customer found (by the mobile's last ten digits) or made for the booker.
  contact_id BIGINT NOT NULL,
  booker_name VARCHAR(150) NOT NULL,
  -- The ten digits given (empty once the customer's data is erased).
  mobile VARCHAR(10) CHECK (mobile ~ '^[6-9][0-9]{9}$'),
  -- Booking for someone else: their name (a clinic: their age and sex too).
  for_whom TEXT NOT NULL DEFAULT 'self' CHECK (for_whom IN ('self', 'someone_else')),
  person_name VARCHAR(150),
  person_age SMALLINT CHECK (person_age BETWEEN 0 AND 120),
  person_sex TEXT CHECK (person_sex IN ('female', 'male', 'other')),
  -- A clinic: new to the clinic or visited before, and the reason (optional).
  visit_kind TEXT CHECK (visit_kind IN ('new', 'follow_up')),
  reason VARCHAR(200),
  note VARCHAR(300),
  -- A garage: the vehicle as typed, and the garage's own record of it when it has one.
  vehicle_no VARCHAR(15),
  vehicle_make VARCHAR(60),
  vehicle_model VARCHAR(60),
  vehicle_id BIGINT,
  -- A gym's, studio's or coaching centre's free trial: the enquiry it made.
  lead_id BIGINT,
  -- A salon: "I am 18 or over, or I am booking for my child as their parent or guardian".
  adult_declared_at TIMESTAMPTZ,
  -- The consents ticked, on the notice shown.
  consents TEXT[] NOT NULL DEFAULT '{}',
  privacy_notice_id BIGINT,
  -- Why it waits for the desk: the link confirms every booking, the mobile's
  -- no-shows, the salon takes deposits, or an advance to check.
  request_reason TEXT CHECK (request_reason IN ('confirm', 'no_shows', 'deposit', 'advance')),
  advance_amount NUMERIC(12,2) CHECK (advance_amount > 0),
  advance_utr VARCHAR(12) CHECK (advance_utr ~ '^[0-9]{12}$'),
  -- The deposit the desk recorded for it on accepting (a receipt in the customer's name).
  advance_collection_id BIGINT,
  decline_reason VARCHAR(300),
  answered_by BIGINT REFERENCES users(id),
  answered_at TIMESTAMPTZ,
  -- Times the guest moved it online.
  changes SMALLINT NOT NULL DEFAULT 0 CHECK (changes >= 0),
  cancelled_by_guest_at TIMESTAMPTZ,
  -- The day-before reminder the desk sent from its own WhatsApp (for a guest who agreed to reminders).
  reminder_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (link_id, client_key),
  FOREIGN KEY (business_id, link_id) REFERENCES business_booking_links(business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, vehicle_id) REFERENCES garage_vehicles(business_id, id),
  FOREIGN KEY (business_id, lead_id) REFERENCES member_leads(business_id, id),
  FOREIGN KEY (business_id, privacy_notice_id) REFERENCES business_privacy_notices(business_id, id),
  FOREIGN KEY (business_id, advance_collection_id) REFERENCES business_collections(business_id, id),
  CHECK ((advance_utr IS NULL) = (advance_amount IS NULL))
);
CREATE INDEX business_online_bookings_mobile ON business_online_bookings(business_id, mobile);
CREATE INDEX business_online_bookings_time ON business_online_bookings(business_id, created_at DESC);

-- Staff screens (the requests, the calendars) and the guest's status page hear of each change.
CREATE TRIGGER business_online_bookings_live AFTER INSERT OR UPDATE OR DELETE ON business_online_bookings
  FOR EACH ROW EXECUTE FUNCTION live_business_row('online_booking', 'id');

-- --- Appointments: requests, guests' rows ------------------------------------------------------------

ALTER TABLE business_appointments DROP CONSTRAINT business_appointments_status_check;
ALTER TABLE business_appointments
  ADD CONSTRAINT business_appointments_status_check
    CHECK (status IN ('booked', 'completed', 'cancelled', 'no_show', 'requested', 'declined', 'expired')),
  ADD COLUMN source TEXT NOT NULL DEFAULT 'staff' CHECK (source IN ('staff', 'guests_site')),
  ALTER COLUMN created_by DROP NOT NULL,
  ADD COLUMN online_booking_id BIGINT,
  ADD COLUMN request_expires_at TIMESTAMPTZ,
  ADD CONSTRAINT business_appointments_made_by CHECK ((created_by IS NULL) = (source = 'guests_site')),
  ADD CONSTRAINT business_appointments_online CHECK ((online_booking_id IS NULL) = (source = 'staff')),
  -- Only a guest's booking is ever a request.
  ADD CONSTRAINT business_appointments_requests CHECK (status NOT IN ('requested', 'declined', 'expired') OR source = 'guests_site'),
  ADD CONSTRAINT business_appointments_request_expiry CHECK (status <> 'requested' OR request_expires_at IS NOT NULL),
  ADD FOREIGN KEY (business_id, online_booking_id) REFERENCES business_online_bookings(business_id, id);
CREATE INDEX business_appointments_requests ON business_appointments(business_id, resource_id, starts_at) WHERE status = 'requested';
CREATE INDEX business_appointments_online_booking ON business_appointments(business_id, online_booking_id) WHERE online_booking_id IS NOT NULL;

-- Does this row hold its time? A booking does; a request does until it is
-- answered, expires or starts. Every clash check, free slot and count of
-- what is to come asks this, the desk's and online alike.
CREATE FUNCTION business_appointment_holds(p_status TEXT, p_expires TIMESTAMPTZ) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT p_status = 'booked' OR (p_status = 'requested' AND p_expires > now())
$$;

-- --- A clinic doctor's profile -----------------------------------------------------------------------

-- Shown to patients before they book; a signatory doctor's own are used
-- while these are empty.
ALTER TABLE health_doctor_profiles
  ADD COLUMN qualifications VARCHAR(120),
  ADD COLUMN registration_no VARCHAR(60),
  ADD COLUMN council VARCHAR(150);

-- --- A salon's deposit on an online booking ----------------------------------------------------------

-- A salon booking's deposit is fixed when it is booked. A guest's online
-- booking is made with none (there is no payment gateway): the desk takes the
-- deposit, or records the UPI advance the guest paid, when it accepts the
-- request, once. Everything else stays as 1791600000000 has it.
CREATE OR REPLACE FUNCTION salon_appointment_details_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Appointment details cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.price_at_booking <> OLD.price_at_booking
     OR (NEW.deposit_collection_id IS DISTINCT FROM OLD.deposit_collection_id
         AND NOT (OLD.deposit_collection_id IS NULL AND EXISTS (SELECT 1 FROM business_appointments a
           WHERE a.business_id = NEW.business_id AND a.id = NEW.appointment_id AND a.source = 'guests_site')))
     OR (OLD.fee_document_id IS NOT NULL AND NEW.fee_document_id IS DISTINCT FROM OLD.fee_document_id)
     OR (OLD.bill_document_id IS NOT NULL AND NEW.bill_document_id IS DISTINCT FROM OLD.bill_document_id)
     OR NEW.request_key <> OLD.request_key THEN
    RAISE EXCEPTION 'A booking''s price and deposit are fixed; its fee and bill are set once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- --- A free trial booked online is a gym's enquiry --------------------------------------------------

ALTER TABLE member_leads
  ALTER COLUMN created_by DROP NOT NULL,
  ADD CONSTRAINT member_leads_made_by CHECK (created_by IS NOT NULL OR source = 'website');

-- Down Migration
-- For test databases (a live rollback is a backup restore). A guest's
-- requests become cancelled bookings and their rows name the business's
-- owner, so the rules before this hold again; the online bookings go.
CREATE OR REPLACE FUNCTION salon_appointment_details_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Appointment details cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.price_at_booking <> OLD.price_at_booking
     OR NEW.deposit_collection_id IS DISTINCT FROM OLD.deposit_collection_id
     OR (OLD.fee_document_id IS NOT NULL AND NEW.fee_document_id IS DISTINCT FROM OLD.fee_document_id)
     OR (OLD.bill_document_id IS NOT NULL AND NEW.bill_document_id IS DISTINCT FROM OLD.bill_document_id)
     OR NEW.request_key <> OLD.request_key THEN
    RAISE EXCEPTION 'A booking''s price and deposit are fixed; its fee and bill are set once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

UPDATE member_leads l SET created_by = (SELECT m.user_id FROM business_memberships m JOIN business_roles r ON r.business_id = m.business_id AND r.id = m.role_id
  WHERE m.business_id = l.business_id AND r.full_access ORDER BY m.user_id LIMIT 1) WHERE l.created_by IS NULL;
ALTER TABLE member_leads DROP CONSTRAINT member_leads_made_by, ALTER COLUMN created_by SET NOT NULL;

ALTER TABLE health_doctor_profiles DROP COLUMN council, DROP COLUMN registration_no, DROP COLUMN qualifications;

DROP FUNCTION business_appointment_holds(TEXT, TIMESTAMPTZ);
DROP INDEX business_appointments_online_booking;
DROP INDEX business_appointments_requests;
ALTER TABLE business_appointments
  DROP CONSTRAINT business_appointments_request_expiry,
  DROP CONSTRAINT business_appointments_requests,
  DROP CONSTRAINT business_appointments_online,
  DROP CONSTRAINT business_appointments_made_by,
  DROP CONSTRAINT business_appointments_status_check;
UPDATE business_appointments SET status = 'cancelled' WHERE status IN ('requested', 'declined', 'expired');
UPDATE business_appointments a SET created_by = (SELECT m.user_id FROM business_memberships m JOIN business_roles r ON r.business_id = m.business_id AND r.id = m.role_id
  WHERE m.business_id = a.business_id AND r.full_access ORDER BY m.user_id LIMIT 1) WHERE a.created_by IS NULL;
ALTER TABLE business_appointments
  DROP COLUMN request_expires_at,
  DROP COLUMN online_booking_id,
  DROP COLUMN source,
  ALTER COLUMN created_by SET NOT NULL,
  ADD CONSTRAINT business_appointments_status_check CHECK (status IN ('booked', 'completed', 'cancelled', 'no_show'));

DROP TRIGGER business_online_bookings_live ON business_online_bookings;
DROP TABLE business_online_bookings;
DROP TABLE business_booking_link_people;
DROP TABLE business_booking_link_services;
DROP TABLE business_booking_links;

DELETE FROM business_role_permissions WHERE permission_code LIKE 'online\_appointments.%';
DELETE FROM business_role_template_permissions WHERE permission_code LIKE 'online\_appointments.%';
DELETE FROM business_permissions WHERE module_code = 'online_appointments';
-- An add-on already bought is a kept record: its foreign key refuses the Down then.
DELETE FROM business_capabilities WHERE capability = 'online_appointments';
DELETE FROM business_subscription_addons WHERE module_code = 'online_appointments';
DELETE FROM platform_module_prices WHERE module_code = 'online_appointments';
DELETE FROM platform_module_business_types WHERE module_code = 'online_appointments';
DELETE FROM platform_module_dependencies WHERE module_code = 'online_appointments';
DELETE FROM platform_modules WHERE code = 'online_appointments';
