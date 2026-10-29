-- Up Migration
-- What a gym, studio or coaching centre does beyond selling and renewing
-- plans: a weekly class timetable with rooms, capacity, a booking window, a
-- cancel cut-off and a waitlist, with attendance and the shop's penalties;
-- trainers' pay and sales commission paid through the expense book; plans
-- with visit limits, branch and time-of-day access, seats for a couple, a
-- family or a company, add-ons, fees for a freeze and a transfer, a freeze's
-- notice, a disclosed late-fee rule and a joining fee that comes back in part;
-- a frozen membership moving its renewal on; a move to a cheaper plan; an
-- instalment schedule changed by a manager; refunds paid after the
-- cancellation; memberships brought from another system; coaching students'
-- details, guardians and test results; enquiries and trial passes; and the
-- member's signed acceptance of the refund policy.
--
-- Added to the module "member_plans" (gyms, studios & coaching):
--   member_plans.manage    set trainers' pay and salespeople's commission, and
--                          pay them through the expense book (managers).
--   member_settings        + the penalties for a late cancel and a no-show (a
--                          session off the pack, or a fee), the penalty fee,
--                          and when a pack's sessions count as running low.
--   member_plan_types      + visits allowed a day, week, month or in all; the
--                          branches and hours it lets a member in; its seats;
--                          the classes it books; personal training or not; the
--                          freeze and transfer fees, a freeze's notice, the
--                          late fee on an instalment and after how many days,
--                          and how much of the joining fee comes back.
--   member_memberships     + the same terms as sold; how it began (a sale,
--                          brought in from another system with what was paid
--                          there, or a trial pass); who sold it and the
--                          trainer it counts for; the days a renewal moved on
--                          when the membership before it was frozen. A
--                          membership brought in or a trial pass has no bill.
--   member_seats           who uses the seats of a shared membership (its
--                          roster); each checks in on their own.
--   member_addons          add-ons sold with a membership or after it (a
--                          locker with its number, a towel, a diet plan, a
--                          personal-training pack), each on a bill; they end
--                          with the membership.
--   member_fees            the fees billed on a membership: a freeze, a
--                          transfer, a late instalment, a class penalty.
--   member_instalments     + versions: a manager changes a schedule without
--                          changing its total; the old version is kept.
--   member_refunds         money to go back to a member on a day (a
--                          cancellation's refund paid later, or what a move to
--                          a cheaper plan leaves over), on the bell until paid.
--   member_rooms, member_class_slots, member_class_sessions,
--   member_class_bookings  the timetable, the classes made from it on the
--                          business's calendar, and their bookings (booked,
--                          waitlisted, promoted, attended, no-show, cancelled,
--                          late cancel).
--   member_pay_rules, member_payouts
--                          what a trainer or salesperson earns (a fixed sum a
--                          month, per class, per personal-training session,
--                          a share of sales), and each month's payout.
--   member_profiles        + date of birth, school and class.
--   member_guardians, member_test_results
--                          a coaching student's guardians (each with a
--                          WhatsApp consent flag) and test results.
--   member_leads           enquiries with their source, interest and follow-up
--                          day; a trial pass; the member they became.
--   member_acceptances     the member's signature accepting the refund policy
--                          (a picture kept privately), with the policy version.

-- --- Permission ------------------------------------------------------------------------------------

INSERT INTO business_permissions (code, module_code, action, name, sort_order) VALUES
 ('member_plans.manage', 'member_plans', 'manage', 'Set trainers'' pay and sales commission, and pay them through the expense book', 517);
INSERT INTO business_role_template_permissions (template_code, permission_code) VALUES ('manager', 'member_plans.manage');
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, 'member_plans.manage' FROM business_roles r WHERE r.template_code = 'manager' AND NOT r.full_access
ON CONFLICT DO NOTHING;

-- --- Settings and plans --------------------------------------------------------------------------

ALTER TABLE member_settings
  ADD COLUMN late_cancel_penalty TEXT NOT NULL DEFAULT 'none' CHECK (late_cancel_penalty IN ('none', 'session', 'fee')),
  ADD COLUMN no_show_penalty TEXT NOT NULL DEFAULT 'none' CHECK (no_show_penalty IN ('none', 'session', 'fee')),
  ADD COLUMN penalty_fee NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (penalty_fee >= 0),
  ADD COLUMN low_sessions SMALLINT NOT NULL DEFAULT 2 CHECK (low_sessions BETWEEN 1 AND 100),
  ADD CONSTRAINT member_settings_penalty_fee CHECK ((late_cancel_penalty <> 'fee' AND no_show_penalty <> 'fee') OR penalty_fee > 0);

ALTER TABLE member_plan_types
  ADD COLUMN visit_limit SMALLINT CHECK (visit_limit BETWEEN 1 AND 1000),
  ADD COLUMN visit_period TEXT CHECK (visit_period IN ('day', 'week', 'month', 'total')),
  ADD COLUMN access_locations BIGINT[] CHECK (cardinality(access_locations) BETWEEN 1 AND 50),
  ADD COLUMN access_from TIME,
  ADD COLUMN access_to TIME,
  ADD COLUMN seats SMALLINT NOT NULL DEFAULT 1 CHECK (seats BETWEEN 1 AND 50),
  ADD COLUMN class_names TEXT[] CHECK (cardinality(class_names) <= 50),
  ADD COLUMN personal_training BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN freeze_fee NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (freeze_fee >= 0),
  ADD COLUMN freeze_notice_days SMALLINT NOT NULL DEFAULT 0 CHECK (freeze_notice_days BETWEEN 0 AND 60),
  ADD COLUMN transfer_fee NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (transfer_fee >= 0),
  ADD COLUMN late_fee NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (late_fee >= 0),
  ADD COLUMN late_fee_after_days SMALLINT NOT NULL DEFAULT 0 CHECK (late_fee_after_days BETWEEN 0 AND 90),
  ADD COLUMN joining_refund_percent SMALLINT NOT NULL DEFAULT 100 CHECK (joining_refund_percent BETWEEN 0 AND 100),
  ADD CONSTRAINT member_plan_types_visits CHECK ((visit_limit IS NULL) = (visit_period IS NULL)),
  ADD CONSTRAINT member_plan_types_hours CHECK ((access_from IS NULL) = (access_to IS NULL) AND (access_from IS NULL OR access_from < access_to));

-- --- Memberships -----------------------------------------------------------------------------------

ALTER TABLE member_memberships
  -- A sale (on a bill), a membership brought in from another system (no bill;
  -- what was paid there), or a trial pass (no bill).
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'sale' CHECK (origin IN ('sale', 'brought_in', 'trial')),
  ADD COLUMN paid_elsewhere NUMERIC(16,2) CHECK (paid_elsewhere >= 0),
  -- The plan's terms as sold.
  ADD COLUMN visit_limit SMALLINT CHECK (visit_limit BETWEEN 1 AND 1000),
  ADD COLUMN visit_period TEXT CHECK (visit_period IN ('day', 'week', 'month', 'total')),
  ADD COLUMN access_locations BIGINT[],
  ADD COLUMN access_from TIME,
  ADD COLUMN access_to TIME,
  ADD COLUMN seats SMALLINT NOT NULL DEFAULT 1 CHECK (seats BETWEEN 1 AND 50),
  ADD COLUMN class_names TEXT[],
  ADD COLUMN personal_training BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN freeze_fee NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (freeze_fee >= 0),
  ADD COLUMN freeze_notice_days SMALLINT NOT NULL DEFAULT 0 CHECK (freeze_notice_days BETWEEN 0 AND 60),
  ADD COLUMN transfer_fee NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (transfer_fee >= 0),
  ADD COLUMN late_fee NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (late_fee >= 0),
  ADD COLUMN late_fee_after_days SMALLINT NOT NULL DEFAULT 0 CHECK (late_fee_after_days BETWEEN 0 AND 90),
  ADD COLUMN joining_refund_percent SMALLINT NOT NULL DEFAULT 100 CHECK (joining_refund_percent BETWEEN 0 AND 100),
  -- Who sold it (their commission) and the trainer it counts for.
  ADD COLUMN sold_by BIGINT REFERENCES users(id),
  ADD COLUMN trainer_id BIGINT,
  -- The days a renewal moved on, with its start and last day, while the
  -- membership before it was frozen.
  ADD COLUMN moved_days SMALLINT NOT NULL DEFAULT 0,
  ALTER COLUMN document_id DROP NOT NULL,
  ALTER COLUMN line_id DROP NOT NULL,
  ADD CONSTRAINT member_memberships_trainer_fkey FOREIGN KEY (business_id, trainer_id) REFERENCES business_resources(business_id, id),
  ADD CONSTRAINT member_memberships_origin_bill CHECK ((origin = 'sale') = (document_id IS NOT NULL) AND (document_id IS NULL) = (line_id IS NULL)),
  ADD CONSTRAINT member_memberships_paid_elsewhere CHECK ((origin = 'brought_in') = (paid_elsewhere IS NOT NULL)),
  ADD CONSTRAINT member_memberships_visits CHECK ((visit_limit IS NULL) = (visit_period IS NULL)),
  ADD CONSTRAINT member_memberships_hours CHECK ((access_from IS NULL) = (access_to IS NULL));
CREATE INDEX member_memberships_sold_by ON member_memberships(business_id, sold_by, created_at) WHERE sold_by IS NOT NULL;
CREATE INDEX member_memberships_trainer ON member_memberships(business_id, trainer_id, created_at) WHERE trainer_id IS NOT NULL;

-- A new membership starts running, with nothing used, frozen, moved or given
-- back. A sale is on its member's own bill, on a line of its plan's item (and
-- a joining fee on the same bill); a renewal or an upgrade is of the member's
-- own membership (an upgrade of one closed as upgraded); a transfer continues
-- a membership closed as transferred, on that membership's bill. A membership
-- brought in from another system or a trial pass has no bill and begins on
-- its own.
CREATE OR REPLACE FUNCTION member_memberships_insert_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE plan RECORD; line RECORD; doc RECORD; source RECORD;
BEGIN
  IF NEW.closed IS NOT NULL OR NEW.sessions_used <> 0 OR NEW.frozen_days <> 0 OR NEW.moved_days <> 0 OR NEW.credit_key IS NOT NULL OR NEW.return_id IS NOT NULL OR NEW.refund_id IS NOT NULL THEN
    RAISE EXCEPTION 'A membership starts running, with nothing used, frozen or given back' USING ERRCODE = '23514';
  END IF;
  IF NEW.origin <> 'sale' THEN
    IF NEW.renewal_of IS NOT NULL OR NEW.upgraded_from IS NOT NULL OR NEW.transferred_from IS NOT NULL THEN
      RAISE EXCEPTION 'A membership brought in from another system, or a trial pass, begins on its own' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT price_sku_id INTO plan FROM member_plan_types WHERE business_id = NEW.business_id AND id = NEW.plan_id;
  SELECT document_id, sku_id INTO line FROM business_document_lines WHERE business_id = NEW.business_id AND id = NEW.line_id;
  IF line.document_id IS DISTINCT FROM NEW.document_id OR line.sku_id IS DISTINCT FROM plan.price_sku_id THEN
    RAISE EXCEPTION 'A membership is sold on a bill line of its plan''s item' USING ERRCODE = '23514';
  END IF;
  IF NEW.joining_line_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM business_document_lines WHERE business_id = NEW.business_id AND id = NEW.joining_line_id AND document_id = NEW.document_id) THEN
    RAISE EXCEPTION 'A joining fee is billed on the membership''s own bill' USING ERRCODE = '23514';
  END IF;
  IF NEW.transferred_from IS NULL THEN
    SELECT kind, contact_id INTO doc FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id;
    IF doc.kind IS DISTINCT FROM 'sale' OR doc.contact_id IS DISTINCT FROM NEW.contact_id THEN
      RAISE EXCEPTION 'A membership is sold on its member''s own bill' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT membership_no, contact_id, plan_id, document_id, line_id, closed INTO source FROM member_memberships WHERE business_id = NEW.business_id AND id = NEW.transferred_from;
    IF source.closed IS DISTINCT FROM 'transferred' OR source.document_id <> NEW.document_id OR source.line_id <> NEW.line_id OR source.plan_id <> NEW.plan_id THEN
      RAISE EXCEPTION 'A transfer carries on membership % as it was sold, once it is closed as transferred', source.membership_no USING ERRCODE = '23514';
    END IF;
    IF source.contact_id = NEW.contact_id THEN
      RAISE EXCEPTION 'A membership is transferred to another member' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.renewal_of IS NOT NULL OR NEW.upgraded_from IS NOT NULL THEN
    SELECT membership_no, contact_id, closed INTO source FROM member_memberships WHERE business_id = NEW.business_id AND id = COALESCE(NEW.renewal_of, NEW.upgraded_from);
    IF source.contact_id <> NEW.contact_id THEN
      RAISE EXCEPTION 'Membership % is another member''s', source.membership_no USING ERRCODE = '23514';
    END IF;
    IF NEW.upgraded_from IS NOT NULL AND source.closed IS DISTINCT FROM 'upgraded' THEN
      RAISE EXCEPTION 'An upgrade follows membership % once it is closed as upgraded', source.membership_no USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- A membership is never deleted. It keeps its member, plan, terms and bill as
-- sold; its frozen days follow its freezes; its sessions used only go up; a
-- renewal not yet begun moves on (or back) with its start and last day by the
-- days the membership before it is frozen; it is closed once (cancelled,
-- transferred or upgraded) and then changes no more, but for what the
-- closing gave back, written once.
CREATE OR REPLACE FUNCTION member_memberships_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE today DATE; moved INT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A membership is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['sessions_used', 'frozen_days', 'end_on', 'closed', 'closed_on', 'close_reason', 'closed_by', 'closed_at', 'close_key', 'close_hash',
        'credit_key', 'return_id', 'credit', 'refund_id', 'refunded', 'approved_by', 'notes', 'updated_by', 'updated_at', 'start_on', 'base_end_on', 'moved_days'])
     <> (to_jsonb(OLD) - ARRAY['sessions_used', 'frozen_days', 'end_on', 'closed', 'closed_on', 'close_reason', 'closed_by', 'closed_at', 'close_key', 'close_hash',
        'credit_key', 'return_id', 'credit', 'refund_id', 'refunded', 'approved_by', 'notes', 'updated_by', 'updated_at', 'start_on', 'base_end_on', 'moved_days']) THEN
    RAISE EXCEPTION 'A membership keeps its member, plan, terms, start and bill as sold' USING ERRCODE = '23514';
  END IF;
  IF NEW.start_on IS DISTINCT FROM OLD.start_on OR NEW.base_end_on IS DISTINCT FROM OLD.base_end_on OR NEW.moved_days <> OLD.moved_days THEN
    SELECT (now() AT TIME ZONE timezone)::date INTO today FROM businesses WHERE id = NEW.business_id;
    moved := NEW.moved_days - OLD.moved_days;
    IF OLD.closed IS NOT NULL OR OLD.renewal_of IS NULL OR NEW.start_on - OLD.start_on <> moved
       OR (OLD.base_end_on IS NOT NULL AND NEW.base_end_on - OLD.base_end_on <> moved) OR (OLD.base_end_on IS NULL AND NEW.base_end_on IS NOT NULL)
       OR LEAST(OLD.start_on, NEW.start_on) <= today THEN
      RAISE EXCEPTION 'A membership keeps its member, plan, terms, start and bill as sold' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.sessions_used < OLD.sessions_used THEN
    RAISE EXCEPTION 'The sessions used on a membership never go back' USING ERRCODE = '23514';
  END IF;
  IF NEW.frozen_days <> OLD.frozen_days
     AND NEW.frozen_days <> (SELECT COALESCE(sum(days), 0) FROM member_freezes WHERE business_id = NEW.business_id AND membership_id = NEW.id) THEN
    RAISE EXCEPTION 'A membership''s frozen days follow its freezes' USING ERRCODE = '23514';
  END IF;
  IF OLD.closed IS NOT NULL THEN
    IF NEW.closed IS DISTINCT FROM OLD.closed OR NEW.closed_on IS DISTINCT FROM OLD.closed_on OR NEW.close_reason IS DISTINCT FROM OLD.close_reason
       OR NEW.closed_by IS DISTINCT FROM OLD.closed_by OR NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.close_key IS DISTINCT FROM OLD.close_key
       OR NEW.close_hash IS DISTINCT FROM OLD.close_hash OR NEW.credit_key IS DISTINCT FROM OLD.credit_key OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.sessions_used <> OLD.sessions_used OR NEW.frozen_days <> OLD.frozen_days OR NEW.notes IS DISTINCT FROM OLD.notes THEN
      RAISE EXCEPTION 'Membership % was % and no longer changes', OLD.membership_no, OLD.closed USING ERRCODE = '23514';
    END IF;
    IF (OLD.return_id IS NOT NULL AND (NEW.return_id IS DISTINCT FROM OLD.return_id OR NEW.credit IS DISTINCT FROM OLD.credit))
       OR (OLD.refund_id IS NOT NULL AND (NEW.refund_id IS DISTINCT FROM OLD.refund_id OR NEW.refunded IS DISTINCT FROM OLD.refunded)) THEN
      RAISE EXCEPTION 'What membership % gave back is kept as it was given', OLD.membership_no USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.return_id IS NOT NULL OR NEW.refund_id IS NOT NULL THEN
    RAISE EXCEPTION 'A membership gives something back only when it is closed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- History and reminders of the new kinds.
ALTER TABLE member_events DROP CONSTRAINT member_events_kind_check, ADD CONSTRAINT member_events_kind_check CHECK (kind IN ('sold', 'renewal', 'upgrade', 'transfer', 'frozen',
  'freeze_ended', 'transferred', 'upgraded', 'cancelled', 'brought_in', 'trial', 'moved', 'seat_added', 'seat_removed', 'addon', 'fee', 'instalments_changed', 'refund_due', 'refund_paid', 'accepted'));
ALTER TABLE member_reminders DROP CONSTRAINT member_reminders_kind_check, ADD CONSTRAINT member_reminders_kind_check CHECK (kind IN ('renewal', 'fees', 'birthday', 'sessions_low', 'grace_end'));

-- --- Seats -----------------------------------------------------------------------------------------

-- Who uses the seats of a shared membership (two for a couple, more for a
-- family or a company); the member who holds it pays. Each checks in on
-- their own. A seat is given up, never deleted.
CREATE TABLE member_seats (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  membership_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_by BIGINT REFERENCES users(id),
  removed_at TIMESTAMPTZ,
  FOREIGN KEY (business_id, membership_id) REFERENCES member_memberships(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id),
  CHECK ((removed_by IS NULL) = (removed_at IS NULL))
);
CREATE UNIQUE INDEX member_seats_current ON member_seats(business_id, membership_id, contact_id) WHERE removed_at IS NULL;
CREATE INDEX member_seats_contact ON member_seats(business_id, contact_id) WHERE removed_at IS NULL;
CREATE TRIGGER member_seats_customer BEFORE INSERT ON member_seats FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- A seat is on a running shared membership, within its seats; it is given up
-- once and never deleted.
CREATE FUNCTION member_seats_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m RECORD; taken INT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A seat is given up, never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.membership_id <> OLD.membership_id OR NEW.contact_id <> OLD.contact_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at OR OLD.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'A seat is kept as it was given; it is given up once' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT membership_no, seats, closed INTO m FROM member_memberships WHERE business_id = NEW.business_id AND id = NEW.membership_id FOR UPDATE;
  IF m.closed IS NOT NULL THEN
    RAISE EXCEPTION 'Membership % was % and takes no one more', m.membership_no, m.closed USING ERRCODE = '23514';
  END IF;
  IF m.seats < 2 THEN
    RAISE EXCEPTION 'Membership % is for one member: it has no seats to share', m.membership_no USING ERRCODE = '23514';
  END IF;
  SELECT count(*)::int INTO taken FROM member_seats WHERE business_id = NEW.business_id AND membership_id = NEW.membership_id AND removed_at IS NULL;
  IF taken >= m.seats THEN
    RAISE EXCEPTION 'Membership % has % seats and all are taken: give one up first', m.membership_no, m.seats USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_seats_check BEFORE INSERT OR UPDATE OR DELETE ON member_seats FOR EACH ROW EXECUTE FUNCTION member_seats_check();

-- --- Add-ons ----------------------------------------------------------------------------------------

-- An add-on sold with a membership or after it, on a bill; it ends with the
-- membership. A locker has its number, never held by two running
-- memberships at once.
CREATE TABLE member_addons (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  membership_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('locker', 'towel', 'diet', 'personal_training', 'other')),
  sku_id BIGINT NOT NULL,
  label VARCHAR(150) NOT NULL CHECK (btrim(label) <> ''),
  locker_no VARCHAR(20) CHECK (locker_no ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'),
  document_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, membership_id) REFERENCES member_memberships(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  UNIQUE (business_id, line_id),
  UNIQUE (business_id, request_key),
  CHECK ((kind = 'locker') = (locker_no IS NOT NULL))
);
CREATE INDEX member_addons_membership ON member_addons(business_id, membership_id);
CREATE INDEX member_addons_locker ON member_addons(business_id, locker_no) WHERE locker_no IS NOT NULL;

-- An add-on is of a membership not closed and not over; its bill line is of
-- its item, on its member's bill; a locker is free (no running membership
-- holds it). It is kept as sold.
CREATE FUNCTION member_addons_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m RECORD; line RECORD; holder TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'An add-on is kept as it was sold' USING ERRCODE = '23514';
  END IF;
  SELECT x.membership_no, x.contact_id, x.closed, x.end_on, (now() AT TIME ZONE b.timezone)::date AS today INTO m
  FROM member_memberships x JOIN businesses b ON b.id = x.business_id WHERE x.business_id = NEW.business_id AND x.id = NEW.membership_id;
  IF m.closed IS NOT NULL OR (m.end_on IS NOT NULL AND m.end_on < m.today) THEN
    RAISE EXCEPTION 'Membership % is over: an add-on goes with a running membership', m.membership_no USING ERRCODE = '23514';
  END IF;
  SELECT l.sku_id, d.contact_id INTO line FROM business_document_lines l JOIN business_documents d ON d.business_id = l.business_id AND d.id = l.document_id
  WHERE l.business_id = NEW.business_id AND l.id = NEW.line_id AND l.document_id = NEW.document_id;
  IF line.sku_id IS DISTINCT FROM NEW.sku_id OR line.contact_id IS DISTINCT FROM m.contact_id THEN
    RAISE EXCEPTION 'An add-on is sold on its member''s bill, on a line of its item' USING ERRCODE = '23514';
  END IF;
  IF NEW.locker_no IS NOT NULL THEN
    SELECT x.membership_no INTO holder FROM member_addons a JOIN member_memberships x ON x.business_id = a.business_id AND x.id = a.membership_id
    WHERE a.business_id = NEW.business_id AND a.locker_no = NEW.locker_no AND x.closed IS NULL AND (x.end_on IS NULL OR x.end_on >= m.today) LIMIT 1;
    IF holder IS NOT NULL THEN
      RAISE EXCEPTION 'Locker % is held by membership % until it ends', NEW.locker_no, holder USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_addons_check BEFORE INSERT OR UPDATE OR DELETE ON member_addons FOR EACH ROW EXECUTE FUNCTION member_addons_check();

-- --- Fees -----------------------------------------------------------------------------------------

-- A fee billed on a membership (a service at the plan's slab): a freeze, a
-- transfer, an instalment paid late (once per instalment), a class's late
-- cancel or no-show.
CREATE TABLE member_fees (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  membership_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('freeze', 'transfer', 'late', 'late_cancel', 'no_show')),
  instalment_due_on DATE,
  instalment_seq SMALLINT,
  booking_id BIGINT,
  amount NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  document_id BIGINT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, membership_id) REFERENCES member_memberships(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, document_id),
  CHECK ((kind = 'late') = (instalment_due_on IS NOT NULL)),
  CHECK ((instalment_due_on IS NULL) = (instalment_seq IS NULL)),
  CHECK ((kind IN ('late_cancel', 'no_show')) = (booking_id IS NOT NULL))
);
CREATE INDEX member_fees_membership ON member_fees(business_id, membership_id);
CREATE UNIQUE INDEX member_fees_late_once ON member_fees(business_id, membership_id, instalment_due_on) WHERE kind = 'late';
CREATE UNIQUE INDEX member_fees_booking_once ON member_fees(business_id, booking_id) WHERE booking_id IS NOT NULL;

-- --- Instalments in versions -------------------------------------------------------------------------

-- A schedule is version 1 as sold; a manager's change writes the next
-- version and marks the one before replaced. Only the replacing is written.
ALTER TABLE member_instalments
  ADD COLUMN version SMALLINT NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 100),
  ADD COLUMN reason VARCHAR(300),
  ADD COLUMN created_by BIGINT REFERENCES users(id),
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN replaced_by BIGINT REFERENCES users(id),
  ADD COLUMN replaced_at TIMESTAMPTZ,
  ADD CONSTRAINT member_instalments_replaced CHECK ((replaced_by IS NULL) = (replaced_at IS NULL)),
  ADD CONSTRAINT member_instalments_reason CHECK ((version = 1) = (reason IS NULL));
ALTER TABLE member_instalments DROP CONSTRAINT member_instalments_pkey, ADD PRIMARY KEY (business_id, membership_id, version, seq);
CREATE INDEX member_instalments_current ON member_instalments(business_id, membership_id) WHERE replaced_at IS NULL;

CREATE FUNCTION member_instalments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.replaced_at IS NULL AND NEW.replaced_at IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['replaced_at', 'replaced_by']) = (to_jsonb(OLD) - ARRAY['replaced_at', 'replaced_by']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A membership''s instalments are kept as they were set' USING ERRCODE = '23514';
END $$;
DROP TRIGGER member_instalments_append_only ON member_instalments;
CREATE TRIGGER member_instalments_append_only BEFORE UPDATE OR DELETE ON member_instalments
  FOR EACH ROW EXECUTE FUNCTION member_instalments_guard();

-- Version 1 is written with its membership: two or more, numbered from 1, in
-- order of their due days, adding up to its bill. A later version replaces
-- the one in force in the same change, keeps its total, and is then the only
-- one in force.
CREATE OR REPLACE FUNCTION member_instalments_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m RECORD; schedule RECORD; target NUMERIC; current INT;
BEGIN
  SELECT x.membership_no, x.transferred_from, x.created_at, d.total INTO m FROM member_memberships x
  LEFT JOIN business_documents d ON d.business_id = x.business_id AND d.id = x.document_id WHERE x.business_id = NEW.business_id AND x.id = NEW.membership_id;
  IF NEW.version = 1 THEN
    IF m.transferred_from IS NOT NULL OR m.created_at <> now() OR m.total IS NULL THEN
      RAISE EXCEPTION 'Instalments are set when membership % is sold', m.membership_no USING ERRCODE = '23514';
    END IF;
    target := m.total;
  ELSE
    SELECT sum(amount) INTO target FROM member_instalments
    WHERE business_id = NEW.business_id AND membership_id = NEW.membership_id AND version = NEW.version - 1 AND replaced_at = now();
    IF target IS NULL THEN
      RAISE EXCEPTION 'A schedule of membership % is changed by replacing the one in force', m.membership_no USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT count(*)::int AS n, max(seq)::int AS last, COALESCE(sum(amount), 0) AS total,
    bool_and(due_on > COALESCE(before, due_on - 1)) AS ordered INTO schedule
  FROM (SELECT seq, due_on, amount, lag(due_on) OVER (ORDER BY seq) AS before FROM member_instalments
        WHERE business_id = NEW.business_id AND membership_id = NEW.membership_id AND version = NEW.version) s;
  IF schedule.n < 2 OR schedule.last <> schedule.n THEN
    RAISE EXCEPTION 'A fee in instalments has two or more, numbered from 1' USING ERRCODE = '23514';
  END IF;
  IF NOT schedule.ordered THEN
    RAISE EXCEPTION 'Each instalment of membership % falls due after the one before', m.membership_no USING ERRCODE = '23514';
  END IF;
  IF schedule.total <> target THEN
    RAISE EXCEPTION 'The instalments of membership % add up to %, not %', m.membership_no, schedule.total, target USING ERRCODE = '23514';
  END IF;
  SELECT count(DISTINCT version)::int INTO current FROM member_instalments WHERE business_id = NEW.business_id AND membership_id = NEW.membership_id AND replaced_at IS NULL;
  IF current <> 1 THEN
    RAISE EXCEPTION 'Membership % has one schedule of instalments in force', m.membership_no USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

-- --- Refunds due --------------------------------------------------------------------------------------

-- Money to go back to a member on a day: a cancellation's refund paid after
-- it, or what a move to a cheaper plan leaves over (a manager's approval).
-- Paid once, through the core's refund on the bill; never deleted.
CREATE TABLE member_refunds (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  membership_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cancelled', 'downgrade')),
  document_id BIGINT NOT NULL,
  amount NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  due_on DATE NOT NULL,
  approved_by BIGINT REFERENCES users(id),
  request_key UUID NOT NULL,
  refund_id BIGINT REFERENCES business_refunds(id),
  paid_by BIGINT REFERENCES users(id),
  paid_at TIMESTAMPTZ,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, membership_id) REFERENCES member_memberships(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  CHECK ((refund_id IS NULL) = (paid_at IS NULL)),
  CHECK ((refund_id IS NULL) = (paid_by IS NULL))
);
CREATE INDEX member_refunds_open ON member_refunds(business_id, due_on) WHERE refund_id IS NULL;

CREATE FUNCTION member_refunds_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.refund_id IS NULL AND NEW.refund_id IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['refund_id', 'paid_by', 'paid_at']) = (to_jsonb(OLD) - ARRAY['refund_id', 'paid_by', 'paid_at']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A refund due is kept as it was set, and paid once' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER member_refunds_guard BEFORE UPDATE OR DELETE ON member_refunds FOR EACH ROW EXECUTE FUNCTION member_refunds_guard();

-- --- Classes ------------------------------------------------------------------------------------------

-- A room classes are held in, at a location.
CREATE TABLE member_rooms (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  name VARCHAR(80) NOT NULL CHECK (btrim(name) <> ''),
  capacity SMALLINT NOT NULL CHECK (capacity BETWEEN 1 AND 500),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX member_rooms_name ON member_rooms(business_id, location_id, lower(name));

-- The weekly timetable: a class on a weekday at a time, in a room, with its
-- instructor (a trainer of Trainers & studios), its places, when booking
-- opens (hours before), the cancel cut-off (hours before) and the waitlist.
CREATE TABLE member_class_slots (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  room_id BIGINT NOT NULL,
  class_name VARCHAR(80) NOT NULL CHECK (btrim(class_name) <> ''),
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  starts_at TIME NOT NULL,
  minutes SMALLINT NOT NULL CHECK (minutes BETWEEN 5 AND 600),
  trainer_id BIGINT,
  capacity SMALLINT NOT NULL CHECK (capacity BETWEEN 1 AND 500),
  book_hours SMALLINT NOT NULL DEFAULT 168 CHECK (book_hours BETWEEN 1 AND 720),
  cancel_hours SMALLINT NOT NULL DEFAULT 2 CHECK (cancel_hours BETWEEN 0 AND 168),
  waitlist_size SMALLINT NOT NULL DEFAULT 0 CHECK (waitlist_size BETWEEN 0 AND 100),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, room_id) REFERENCES member_rooms(business_id, id),
  FOREIGN KEY (business_id, trainer_id) REFERENCES business_resources(business_id, id),
  UNIQUE (business_id, id)
);
CREATE INDEX member_class_slots_day ON member_class_slots(business_id, weekday) WHERE active;

-- A class on a day, made from the timetable (its terms copied as they were
-- then), or called off with a reason. One nobody has booked is made again
-- when its timetable entry changes.
CREATE TABLE member_class_sessions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  slot_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  room_id BIGINT NOT NULL,
  trainer_id BIGINT,
  class_name VARCHAR(80) NOT NULL,
  day DATE NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL CHECK (ends_at > starts_at),
  capacity SMALLINT NOT NULL CHECK (capacity BETWEEN 1 AND 500),
  book_from TIMESTAMPTZ NOT NULL CHECK (book_from < starts_at),
  cancel_until TIMESTAMPTZ NOT NULL CHECK (cancel_until <= starts_at),
  waitlist_size SMALLINT NOT NULL CHECK (waitlist_size BETWEEN 0 AND 100),
  cancelled_at TIMESTAMPTZ,
  cancelled_by BIGINT REFERENCES users(id),
  cancel_reason VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, slot_id) REFERENCES member_class_slots(business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, room_id) REFERENCES member_rooms(business_id, id),
  FOREIGN KEY (business_id, trainer_id) REFERENCES business_resources(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, slot_id, day),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL)),
  CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL))
);
CREATE INDEX member_class_sessions_day ON member_class_sessions(business_id, day, starts_at);
CREATE INDEX member_class_sessions_trainer ON member_class_sessions(business_id, trainer_id, day) WHERE trainer_id IS NOT NULL;

CREATE FUNCTION member_class_sessions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['cancelled_at', 'cancelled_by', 'cancel_reason']) = (to_jsonb(OLD) - ARRAY['cancelled_at', 'cancelled_by', 'cancel_reason']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND OLD.cancelled_at IS NULL AND NOT EXISTS (SELECT 1 FROM member_class_bookings b WHERE b.business_id = OLD.business_id AND b.session_id = OLD.id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'A class with bookings is kept as it was made; it is called off once' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER member_class_sessions_guard BEFORE UPDATE OR DELETE ON member_class_sessions FOR EACH ROW EXECUTE FUNCTION member_class_sessions_guard();

-- A member's place in a class: booked, or waitlisted and then promoted when a
-- place frees; then attended, a no-show, cancelled, or a late cancel (after
-- the cut-off). A pack's session is taken by attending or by a penalty.
CREATE TABLE member_class_bookings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  session_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  membership_id BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('booked', 'waitlisted', 'promoted', 'attended', 'no_show', 'cancelled', 'late_cancel')),
  promoted_at TIMESTAMPTZ,
  session_used BOOLEAN NOT NULL DEFAULT FALSE,
  penalty TEXT CHECK (penalty IN ('session', 'fee')),
  marked_by BIGINT REFERENCES users(id),
  marked_at TIMESTAMPTZ,
  request_key UUID NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, session_id) REFERENCES member_class_sessions(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, membership_id) REFERENCES member_memberships(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  CHECK ((status = 'promoted') <= (promoted_at IS NOT NULL)),
  CHECK (penalty IS NULL OR status IN ('no_show', 'late_cancel')),
  CHECK (NOT session_used OR status IN ('attended', 'no_show', 'late_cancel')),
  CHECK ((marked_at IS NULL) = (marked_by IS NULL))
);
CREATE UNIQUE INDEX member_class_bookings_one ON member_class_bookings(business_id, session_id, contact_id) WHERE status NOT IN ('cancelled', 'late_cancel');
CREATE INDEX member_class_bookings_session ON member_class_bookings(business_id, session_id, id);
CREATE INDEX member_class_bookings_member ON member_class_bookings(business_id, contact_id, id DESC);
CREATE TRIGGER member_class_bookings_customer BEFORE INSERT ON member_class_bookings FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();
ALTER TABLE member_fees ADD CONSTRAINT member_fees_booking_fkey FOREIGN KEY (business_id, booking_id) REFERENCES member_class_bookings(business_id, id);

-- A class holds no more than its places (booked, promoted, attended and
-- no-shows) and its waitlist; the class is locked first, so two asking for
-- the last place at once are one in, one not. A booking moves on from booked
-- or waitlisted only: waitlisted to promoted or cancelled; booked or
-- promoted to attended, no-show, cancelled or late cancel; then it is kept.
CREATE FUNCTION member_class_bookings_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s RECORD; held INT; waiting INT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A class booking is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  SELECT class_name, capacity, waitlist_size, cancelled_at INTO s FROM member_class_sessions WHERE business_id = NEW.business_id AND id = NEW.session_id FOR UPDATE;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.session_id <> OLD.session_id OR NEW.contact_id <> OLD.contact_id OR NEW.membership_id <> OLD.membership_id OR NEW.request_key <> OLD.request_key
       OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'A class booking keeps its class, member and membership' USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
         (OLD.status = 'waitlisted' AND NEW.status IN ('promoted', 'cancelled'))
      OR (OLD.status IN ('booked', 'promoted') AND NEW.status IN ('attended', 'no_show', 'cancelled', 'late_cancel'))) THEN
      RAISE EXCEPTION 'A booking that is % does not become %', replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = '23514';
    END IF;
    IF NEW.status = OLD.status AND (NEW.session_used <> OLD.session_used OR NEW.penalty IS DISTINCT FROM OLD.penalty) THEN
      RAISE EXCEPTION 'A class booking is kept as it was marked' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status NOT IN ('booked', 'waitlisted') OR NEW.session_used OR NEW.penalty IS NOT NULL THEN
    RAISE EXCEPTION 'A booking starts booked or on the waitlist' USING ERRCODE = '23514';
  END IF;
  IF s.cancelled_at IS NOT NULL AND NEW.status NOT IN ('cancelled') THEN
    RAISE EXCEPTION 'The % class was called off', s.class_name USING ERRCODE = '23514';
  END IF;
  SELECT count(*) FILTER (WHERE status IN ('booked', 'promoted', 'attended', 'no_show'))::int, count(*) FILTER (WHERE status = 'waitlisted')::int INTO held, waiting
  FROM member_class_bookings WHERE business_id = NEW.business_id AND session_id = NEW.session_id AND id IS DISTINCT FROM NEW.id;
  IF NEW.status IN ('booked', 'promoted', 'attended', 'no_show') AND held + 1 > s.capacity THEN
    RAISE EXCEPTION 'The % class is full: its % places are taken', s.class_name, s.capacity USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'waitlisted' AND waiting + 1 > s.waitlist_size THEN
    RAISE EXCEPTION 'The % class and its waitlist are full', s.class_name USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_class_bookings_check BEFORE INSERT OR UPDATE OR DELETE ON member_class_bookings FOR EACH ROW EXECUTE FUNCTION member_class_bookings_check();

-- --- Trainers' pay and commission -----------------------------------------------------------------------

-- What a trainer (of Trainers & studios) or a salesperson (a staff login)
-- earns from a month on: a fixed sum a month, per class taken (with someone
-- attending), per personal-training session given, and a share of the
-- personal-training and other plans they sold. A new rule replaces the one
-- before from its month; rules are kept as written.
CREATE TABLE member_pay_rules (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  trainer_id BIGINT,
  user_id BIGINT REFERENCES users(id),
  from_month DATE NOT NULL CHECK (extract(day FROM from_month) = 1),
  fixed_monthly NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (fixed_monthly >= 0),
  per_class NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (per_class >= 0),
  per_pt_session NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (per_pt_session >= 0),
  pt_sales_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (pt_sales_percent BETWEEN 0 AND 100),
  plan_sales_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (plan_sales_percent BETWEEN 0 AND 100),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, trainer_id) REFERENCES business_resources(business_id, id),
  CHECK (num_nonnulls(trainer_id, user_id) = 1)
);
CREATE INDEX member_pay_rules_person ON member_pay_rules(business_id, trainer_id, user_id, from_month DESC, id DESC);

-- A month's pay to one person, as worked out then (the figures kept), paid
-- through the expense book.
CREATE TABLE member_payouts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  trainer_id BIGINT,
  user_id BIGINT REFERENCES users(id),
  month DATE NOT NULL CHECK (extract(day FROM month) = 1),
  amount NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  figures JSONB NOT NULL CHECK (jsonb_typeof(figures) = 'object'),
  expense_id BIGINT NOT NULL,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, trainer_id) REFERENCES business_resources(business_id, id),
  FOREIGN KEY (business_id, expense_id) REFERENCES business_expenses(business_id, id),
  UNIQUE (business_id, request_key),
  CHECK (num_nonnulls(trainer_id, user_id) = 1)
);
CREATE INDEX member_payouts_month ON member_payouts(business_id, month);

CREATE FUNCTION member_pay_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'member_pay_rules' THEN
    RAISE EXCEPTION 'A pay rule is kept as it was written: write a new one from a month instead' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'A payout is kept as it was paid; reverse its expense to undo it' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER member_pay_rules_append_only BEFORE UPDATE OR DELETE ON member_pay_rules FOR EACH ROW EXECUTE FUNCTION member_pay_append_only();
CREATE TRIGGER member_payouts_append_only BEFORE UPDATE OR DELETE ON member_payouts FOR EACH ROW EXECUTE FUNCTION member_pay_append_only();

-- --- Students ----------------------------------------------------------------------------------------

ALTER TABLE member_profiles
  ADD COLUMN date_of_birth DATE CHECK (date_of_birth >= DATE '1900-01-01'),
  ADD COLUMN school VARCHAR(150),
  ADD COLUMN class_name VARCHAR(40);

-- A coaching student's guardians: each with a phone and whether they agreed
-- to messages on WhatsApp.
CREATE TABLE member_guardians (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  name VARCHAR(150) NOT NULL CHECK (btrim(name) <> ''),
  relation VARCHAR(40),
  phone VARCHAR(30),
  whatsapp_consent BOOLEAN NOT NULL DEFAULT FALSE,
  consent_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id),
  CHECK (NOT whatsapp_consent OR consent_at IS NOT NULL)
);
CREATE INDEX member_guardians_student ON member_guardians(business_id, contact_id);

-- A student's test results: the test, its day, the marks out of what, and remarks.
CREATE TABLE member_test_results (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  test_name VARCHAR(150) NOT NULL CHECK (btrim(test_name) <> ''),
  taken_on DATE NOT NULL,
  marks NUMERIC(7,2) NOT NULL CHECK (marks >= 0),
  out_of NUMERIC(7,2) NOT NULL CHECK (out_of > 0),
  remarks VARCHAR(500),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id),
  CHECK (marks <= out_of)
);
CREATE INDEX member_test_results_student ON member_test_results(business_id, contact_id, taken_on);

-- --- Enquiries and trial passes -------------------------------------------------------------------------

-- An enquiry: who asked, how they came, what they want and when to call
-- back; a trial pass given; the member they became, or why not.
CREATE TABLE member_leads (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  name VARCHAR(150) NOT NULL CHECK (btrim(name) <> ''),
  phone VARCHAR(30),
  email VARCHAR(150),
  source TEXT NOT NULL CHECK (source IN ('walk_in', 'phone', 'whatsapp', 'social', 'website', 'referral', 'other')),
  interest VARCHAR(200),
  follow_up_on DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'trial', 'member', 'lost')),
  notes VARCHAR(1000),
  lost_reason VARCHAR(300),
  contact_id BIGINT,
  trial_membership_id BIGINT,
  membership_id BIGINT,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, trial_membership_id) REFERENCES member_memberships(business_id, id),
  FOREIGN KEY (business_id, membership_id) REFERENCES member_memberships(business_id, id),
  UNIQUE (business_id, id),
  CHECK ((status = 'member') = (membership_id IS NOT NULL)),
  CHECK (status <> 'trial' OR trial_membership_id IS NOT NULL),
  CHECK ((status = 'lost') = (lost_reason IS NOT NULL)),
  CHECK (trial_membership_id IS NULL OR contact_id IS NOT NULL)
);
CREATE INDEX member_leads_follow_up ON member_leads(business_id, follow_up_on) WHERE status IN ('open', 'trial');
CREATE INDEX member_leads_contact ON member_leads(business_id, contact_id) WHERE contact_id IS NOT NULL;

-- --- The member's acceptance -------------------------------------------------------------------------------

-- The member's signature drawn on the screen accepting the refund policy of
-- their membership (the version it was sold with): a picture kept in the
-- private uploads folder, sent only through the API, never changed.
CREATE TABLE member_acceptances (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  membership_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  policy_version SMALLINT NOT NULL,
  signed_by_name VARCHAR(150) NOT NULL CHECK (btrim(signed_by_name) <> ''),
  stored_name VARCHAR(80) NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, membership_id) REFERENCES member_memberships(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id)
);
CREATE INDEX member_acceptances_membership ON member_acceptances(business_id, membership_id);

-- An acceptance is of the membership's own policy version, signed by its
-- member or one of its seats; it is never changed or deleted.
CREATE FUNCTION member_acceptances_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A signed acceptance is kept as it was signed' USING ERRCODE = '23514';
  END IF;
  SELECT membership_no, contact_id, policy_version INTO m FROM member_memberships WHERE business_id = NEW.business_id AND id = NEW.membership_id;
  IF m.policy_version <> NEW.policy_version THEN
    RAISE EXCEPTION 'Membership % was sold with version % of its refund policy', m.membership_no, m.policy_version USING ERRCODE = '23514';
  END IF;
  IF m.contact_id <> NEW.contact_id AND NOT EXISTS (SELECT 1 FROM member_seats s WHERE s.business_id = NEW.business_id AND s.membership_id = NEW.membership_id
       AND s.contact_id = NEW.contact_id) THEN
    RAISE EXCEPTION 'Membership % is another member''s', m.membership_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_acceptances_check BEFORE INSERT OR UPDATE OR DELETE ON member_acceptances FOR EACH ROW EXECUTE FUNCTION member_acceptances_check();

-- --- Check-ins: seats, branches, hours and visits ------------------------------------------------------------

ALTER TABLE member_checkins DROP CONSTRAINT member_checkins_reason_check, ADD CONSTRAINT member_checkins_reason_check
  CHECK (reason IN ('no_membership', 'not_started', 'expired', 'frozen', 'no_sessions', 'dues', 'branch', 'time_of_day', 'visit_limit'));
DROP INDEX member_checkins_one_session_a_day;
CREATE UNIQUE INDEX member_checkins_one_session_a_day ON member_checkins(business_id, membership_id, contact_id, day) WHERE session_used;

-- A check-in is dated on the business's clock. One that lets a member in is
-- on their own membership (or a seat of a shared one) while it runs that
-- day: started, not closed, not frozen, within its last day and grace days,
-- at a branch and an hour it allows, within its visits; a pack's session is
-- used only while one is left.
CREATE OR REPLACE FUNCTION member_checkins_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m RECORD; tz TEXT; visits INT; since DATE; at_time TIME;
BEGIN
  SELECT timezone INTO tz FROM businesses WHERE id = NEW.business_id;
  NEW.day := (NEW.created_at AT TIME ZONE tz)::date;
  IF NEW.membership_id IS NULL THEN RETURN NEW; END IF;
  SELECT membership_no, contact_id, seats, closed, start_on, end_on, grace_days, sessions_total, sessions_used, access_locations, access_from, access_to, visit_limit, visit_period INTO m
  FROM member_memberships WHERE business_id = NEW.business_id AND id = NEW.membership_id FOR UPDATE;
  IF (m.seats = 1 AND m.contact_id <> NEW.contact_id)
     OR (m.seats > 1 AND NOT EXISTS (SELECT 1 FROM member_seats s WHERE s.business_id = NEW.business_id AND s.membership_id = NEW.membership_id
       AND s.contact_id = NEW.contact_id AND s.removed_at IS NULL)) THEN
    RAISE EXCEPTION 'Membership % is another member''s', m.membership_no USING ERRCODE = '23514';
  END IF;
  IF NEW.session_used AND m.sessions_total IS NULL THEN
    RAISE EXCEPTION 'Membership % has no sessions to count', m.membership_no USING ERRCODE = '23514';
  END IF;
  IF NOT NEW.allowed THEN RETURN NEW; END IF;
  IF m.closed IS NOT NULL THEN
    RAISE EXCEPTION 'Membership % was % and lets no one in', m.membership_no, m.closed USING ERRCODE = '23514';
  END IF;
  IF NEW.day < m.start_on THEN
    RAISE EXCEPTION 'Membership % starts on %', m.membership_no, to_char(m.start_on, 'DD Mon YYYY') USING ERRCODE = '23514';
  END IF;
  IF m.end_on IS NOT NULL AND NEW.day > m.end_on + m.grace_days THEN
    RAISE EXCEPTION 'Membership % ran out on %', m.membership_no, to_char(m.end_on, 'DD Mon YYYY') USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM member_freezes f WHERE f.business_id = NEW.business_id AND f.membership_id = NEW.membership_id AND f.days > 0
             AND NEW.day BETWEEN f.starts_on AND f.starts_on + f.days - 1) THEN
    RAISE EXCEPTION 'Membership % is frozen today', m.membership_no USING ERRCODE = '23514';
  END IF;
  IF NEW.session_used AND m.sessions_used >= m.sessions_total THEN
    RAISE EXCEPTION 'Membership % has no sessions left', m.membership_no USING ERRCODE = '23514';
  END IF;
  IF m.access_locations IS NOT NULL AND NOT NEW.location_id = ANY(m.access_locations) THEN
    RAISE EXCEPTION 'Membership % does not let its member in at this branch', m.membership_no USING ERRCODE = '23514';
  END IF;
  at_time := (NEW.created_at AT TIME ZONE tz)::time;
  IF m.access_from IS NOT NULL AND (at_time < m.access_from OR at_time >= m.access_to) THEN
    RAISE EXCEPTION 'Membership % lets its member in from % to %', m.membership_no, to_char(m.access_from, 'HH24:MI'), to_char(m.access_to, 'HH24:MI') USING ERRCODE = '23514';
  END IF;
  IF m.visit_limit IS NOT NULL THEN
    since := CASE m.visit_period WHEN 'day' THEN NEW.day WHEN 'week' THEN date_trunc('week', NEW.day)::date WHEN 'month' THEN date_trunc('month', NEW.day)::date ELSE m.start_on END;
    SELECT count(*)::int INTO visits FROM member_checkins k WHERE k.business_id = NEW.business_id AND k.membership_id = NEW.membership_id
      AND k.contact_id = NEW.contact_id AND k.allowed AND k.day BETWEEN since AND NEW.day;
    IF visits >= m.visit_limit THEN
      RAISE EXCEPTION 'Membership % allows % visits %: all are used', m.membership_no, m.visit_limit,
        CASE m.visit_period WHEN 'total' THEN 'in all' ELSE 'a ' || m.visit_period END USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Down Migration
CREATE OR REPLACE FUNCTION member_checkins_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m RECORD;
BEGIN
  NEW.day := (NEW.created_at AT TIME ZONE (SELECT timezone FROM businesses WHERE id = NEW.business_id))::date;
  IF NEW.membership_id IS NULL THEN RETURN NEW; END IF;
  SELECT membership_no, contact_id, closed, start_on, end_on, grace_days, sessions_total, sessions_used INTO m
  FROM member_memberships WHERE business_id = NEW.business_id AND id = NEW.membership_id FOR UPDATE;
  IF m.contact_id <> NEW.contact_id THEN
    RAISE EXCEPTION 'Membership % is another member''s', m.membership_no USING ERRCODE = '23514';
  END IF;
  IF NEW.session_used AND m.sessions_total IS NULL THEN
    RAISE EXCEPTION 'Membership % has no sessions to count', m.membership_no USING ERRCODE = '23514';
  END IF;
  IF NOT NEW.allowed THEN RETURN NEW; END IF;
  IF m.closed IS NOT NULL THEN
    RAISE EXCEPTION 'Membership % was % and lets no one in', m.membership_no, m.closed USING ERRCODE = '23514';
  END IF;
  IF NEW.day < m.start_on THEN
    RAISE EXCEPTION 'Membership % starts on %', m.membership_no, to_char(m.start_on, 'DD Mon YYYY') USING ERRCODE = '23514';
  END IF;
  IF m.end_on IS NOT NULL AND NEW.day > m.end_on + m.grace_days THEN
    RAISE EXCEPTION 'Membership % ran out on %', m.membership_no, to_char(m.end_on, 'DD Mon YYYY') USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM member_freezes f WHERE f.business_id = NEW.business_id AND f.membership_id = NEW.membership_id AND f.days > 0
             AND NEW.day BETWEEN f.starts_on AND f.starts_on + f.days - 1) THEN
    RAISE EXCEPTION 'Membership % is frozen today', m.membership_no USING ERRCODE = '23514';
  END IF;
  IF NEW.session_used AND m.sessions_used >= m.sessions_total THEN
    RAISE EXCEPTION 'Membership % has no sessions left', m.membership_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP INDEX member_checkins_one_session_a_day;
CREATE UNIQUE INDEX member_checkins_one_session_a_day ON member_checkins(business_id, membership_id, day) WHERE session_used;
ALTER TABLE member_checkins DROP CONSTRAINT member_checkins_reason_check, ADD CONSTRAINT member_checkins_reason_check
  CHECK (reason IN ('no_membership', 'not_started', 'expired', 'frozen', 'no_sessions', 'dues'));

DROP TABLE member_acceptances, member_leads, member_test_results, member_guardians, member_payouts, member_pay_rules;
DROP FUNCTION member_acceptances_check();
DROP FUNCTION member_pay_append_only();
ALTER TABLE member_profiles DROP COLUMN date_of_birth, DROP COLUMN school, DROP COLUMN class_name;
DROP TABLE member_fees, member_class_bookings, member_class_sessions, member_class_slots, member_rooms, member_refunds, member_addons, member_seats;
DROP FUNCTION member_class_bookings_check();
DROP FUNCTION member_class_sessions_guard();
DROP FUNCTION member_refunds_guard();
DROP FUNCTION member_addons_check();
DROP FUNCTION member_seats_check();

-- Instalments: back to one schedule as sold.
CREATE OR REPLACE FUNCTION member_instalments_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m RECORD; schedule RECORD;
BEGIN
  SELECT x.membership_no, x.transferred_from, x.created_at, d.total INTO m FROM member_memberships x
  JOIN business_documents d ON d.business_id = x.business_id AND d.id = x.document_id WHERE x.business_id = NEW.business_id AND x.id = NEW.membership_id;
  IF m.transferred_from IS NOT NULL OR m.created_at <> now() THEN
    RAISE EXCEPTION 'Instalments are set when membership % is sold', m.membership_no USING ERRCODE = '23514';
  END IF;
  SELECT count(*)::int AS n, max(seq)::int AS last, COALESCE(sum(amount), 0) AS total,
    bool_and(due_on > COALESCE(before, due_on - 1)) AS ordered INTO schedule
  FROM (SELECT seq, due_on, amount, lag(due_on) OVER (ORDER BY seq) AS before FROM member_instalments
        WHERE business_id = NEW.business_id AND membership_id = NEW.membership_id) s;
  IF schedule.n < 2 OR schedule.last <> schedule.n THEN
    RAISE EXCEPTION 'A fee in instalments has two or more, numbered from 1' USING ERRCODE = '23514';
  END IF;
  IF NOT schedule.ordered THEN
    RAISE EXCEPTION 'Each instalment of membership % falls due after the one before', m.membership_no USING ERRCODE = '23514';
  END IF;
  IF schedule.total <> m.total THEN
    RAISE EXCEPTION 'The instalments of membership % add up to %, not its bill of %', m.membership_no, schedule.total, m.total USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER member_instalments_append_only ON member_instalments;
DELETE FROM member_instalments WHERE version > 1;
CREATE TRIGGER member_instalments_append_only BEFORE UPDATE OR DELETE ON member_instalments
  FOR EACH ROW EXECUTE FUNCTION member_append_only();
DROP FUNCTION member_instalments_guard();
DROP INDEX member_instalments_current;
ALTER TABLE member_instalments DROP CONSTRAINT member_instalments_pkey, ADD PRIMARY KEY (business_id, membership_id, seq);
ALTER TABLE member_instalments DROP CONSTRAINT member_instalments_replaced, DROP CONSTRAINT member_instalments_reason,
  DROP COLUMN version, DROP COLUMN reason, DROP COLUMN created_by, DROP COLUMN created_at, DROP COLUMN replaced_by, DROP COLUMN replaced_at;

ALTER TABLE member_reminders DROP CONSTRAINT member_reminders_kind_check, ADD CONSTRAINT member_reminders_kind_check CHECK (kind IN ('renewal', 'fees'));
ALTER TABLE member_events DROP CONSTRAINT member_events_kind_check, ADD CONSTRAINT member_events_kind_check CHECK (kind IN ('sold', 'renewal', 'upgrade', 'transfer', 'frozen',
  'freeze_ended', 'transferred', 'upgraded', 'cancelled'));

CREATE OR REPLACE FUNCTION member_memberships_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A membership is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['sessions_used', 'frozen_days', 'end_on', 'closed', 'closed_on', 'close_reason', 'closed_by', 'closed_at', 'close_key', 'close_hash',
        'credit_key', 'return_id', 'credit', 'refund_id', 'refunded', 'approved_by', 'notes', 'updated_by', 'updated_at'])
     <> (to_jsonb(OLD) - ARRAY['sessions_used', 'frozen_days', 'end_on', 'closed', 'closed_on', 'close_reason', 'closed_by', 'closed_at', 'close_key', 'close_hash',
        'credit_key', 'return_id', 'credit', 'refund_id', 'refunded', 'approved_by', 'notes', 'updated_by', 'updated_at']) THEN
    RAISE EXCEPTION 'A membership keeps its member, plan, terms, start and bill as sold' USING ERRCODE = '23514';
  END IF;
  IF NEW.sessions_used < OLD.sessions_used THEN
    RAISE EXCEPTION 'The sessions used on a membership never go back' USING ERRCODE = '23514';
  END IF;
  IF NEW.frozen_days <> OLD.frozen_days
     AND NEW.frozen_days <> (SELECT COALESCE(sum(days), 0) FROM member_freezes WHERE business_id = NEW.business_id AND membership_id = NEW.id) THEN
    RAISE EXCEPTION 'A membership''s frozen days follow its freezes' USING ERRCODE = '23514';
  END IF;
  IF OLD.closed IS NOT NULL THEN
    IF NEW.closed IS DISTINCT FROM OLD.closed OR NEW.closed_on IS DISTINCT FROM OLD.closed_on OR NEW.close_reason IS DISTINCT FROM OLD.close_reason
       OR NEW.closed_by IS DISTINCT FROM OLD.closed_by OR NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.close_key IS DISTINCT FROM OLD.close_key
       OR NEW.close_hash IS DISTINCT FROM OLD.close_hash OR NEW.credit_key IS DISTINCT FROM OLD.credit_key OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.sessions_used <> OLD.sessions_used OR NEW.frozen_days <> OLD.frozen_days OR NEW.notes IS DISTINCT FROM OLD.notes THEN
      RAISE EXCEPTION 'Membership % was % and no longer changes', OLD.membership_no, OLD.closed USING ERRCODE = '23514';
    END IF;
    IF (OLD.return_id IS NOT NULL AND (NEW.return_id IS DISTINCT FROM OLD.return_id OR NEW.credit IS DISTINCT FROM OLD.credit))
       OR (OLD.refund_id IS NOT NULL AND (NEW.refund_id IS DISTINCT FROM OLD.refund_id OR NEW.refunded IS DISTINCT FROM OLD.refunded)) THEN
      RAISE EXCEPTION 'What membership % gave back is kept as it was given', OLD.membership_no USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.return_id IS NOT NULL OR NEW.refund_id IS NOT NULL THEN
    RAISE EXCEPTION 'A membership gives something back only when it is closed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION member_memberships_insert_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE plan RECORD; line RECORD; doc RECORD; source RECORD;
BEGIN
  IF NEW.closed IS NOT NULL OR NEW.sessions_used <> 0 OR NEW.frozen_days <> 0 OR NEW.credit_key IS NOT NULL OR NEW.return_id IS NOT NULL OR NEW.refund_id IS NOT NULL THEN
    RAISE EXCEPTION 'A membership starts running, with nothing used, frozen or given back' USING ERRCODE = '23514';
  END IF;
  SELECT price_sku_id INTO plan FROM member_plan_types WHERE business_id = NEW.business_id AND id = NEW.plan_id;
  SELECT document_id, sku_id INTO line FROM business_document_lines WHERE business_id = NEW.business_id AND id = NEW.line_id;
  IF line.document_id IS DISTINCT FROM NEW.document_id OR line.sku_id IS DISTINCT FROM plan.price_sku_id THEN
    RAISE EXCEPTION 'A membership is sold on a bill line of its plan''s item' USING ERRCODE = '23514';
  END IF;
  IF NEW.joining_line_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM business_document_lines WHERE business_id = NEW.business_id AND id = NEW.joining_line_id AND document_id = NEW.document_id) THEN
    RAISE EXCEPTION 'A joining fee is billed on the membership''s own bill' USING ERRCODE = '23514';
  END IF;
  IF NEW.transferred_from IS NULL THEN
    SELECT kind, contact_id INTO doc FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id;
    IF doc.kind IS DISTINCT FROM 'sale' OR doc.contact_id IS DISTINCT FROM NEW.contact_id THEN
      RAISE EXCEPTION 'A membership is sold on its member''s own bill' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT membership_no, contact_id, plan_id, document_id, line_id, closed INTO source FROM member_memberships WHERE business_id = NEW.business_id AND id = NEW.transferred_from;
    IF source.closed IS DISTINCT FROM 'transferred' OR source.document_id <> NEW.document_id OR source.line_id <> NEW.line_id OR source.plan_id <> NEW.plan_id THEN
      RAISE EXCEPTION 'A transfer carries on membership % as it was sold, once it is closed as transferred', source.membership_no USING ERRCODE = '23514';
    END IF;
    IF source.contact_id = NEW.contact_id THEN
      RAISE EXCEPTION 'A membership is transferred to another member' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.renewal_of IS NOT NULL OR NEW.upgraded_from IS NOT NULL THEN
    SELECT membership_no, contact_id, closed INTO source FROM member_memberships WHERE business_id = NEW.business_id AND id = COALESCE(NEW.renewal_of, NEW.upgraded_from);
    IF source.contact_id <> NEW.contact_id THEN
      RAISE EXCEPTION 'Membership % is another member''s', source.membership_no USING ERRCODE = '23514';
    END IF;
    IF NEW.upgraded_from IS NOT NULL AND source.closed IS DISTINCT FROM 'upgraded' THEN
      RAISE EXCEPTION 'An upgrade follows membership % once it is closed as upgraded', source.membership_no USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP INDEX member_memberships_sold_by;
DROP INDEX member_memberships_trainer;
ALTER TABLE member_memberships DROP CONSTRAINT member_memberships_trainer_fkey, DROP CONSTRAINT member_memberships_origin_bill, DROP CONSTRAINT member_memberships_paid_elsewhere,
  DROP CONSTRAINT member_memberships_visits, DROP CONSTRAINT member_memberships_hours,
  DROP COLUMN origin, DROP COLUMN paid_elsewhere, DROP COLUMN visit_limit, DROP COLUMN visit_period, DROP COLUMN access_locations, DROP COLUMN access_from, DROP COLUMN access_to,
  DROP COLUMN seats, DROP COLUMN class_names, DROP COLUMN personal_training, DROP COLUMN freeze_fee, DROP COLUMN freeze_notice_days, DROP COLUMN transfer_fee, DROP COLUMN late_fee,
  DROP COLUMN late_fee_after_days, DROP COLUMN joining_refund_percent, DROP COLUMN sold_by, DROP COLUMN trainer_id, DROP COLUMN moved_days,
  ALTER COLUMN document_id SET NOT NULL, ALTER COLUMN line_id SET NOT NULL;

ALTER TABLE member_plan_types DROP CONSTRAINT member_plan_types_visits, DROP CONSTRAINT member_plan_types_hours,
  DROP COLUMN visit_limit, DROP COLUMN visit_period, DROP COLUMN access_locations, DROP COLUMN access_from, DROP COLUMN access_to, DROP COLUMN seats, DROP COLUMN class_names,
  DROP COLUMN personal_training, DROP COLUMN freeze_fee, DROP COLUMN freeze_notice_days, DROP COLUMN transfer_fee, DROP COLUMN late_fee, DROP COLUMN late_fee_after_days,
  DROP COLUMN joining_refund_percent;
ALTER TABLE member_settings DROP CONSTRAINT member_settings_penalty_fee,
  DROP COLUMN late_cancel_penalty, DROP COLUMN no_show_penalty, DROP COLUMN penalty_fee, DROP COLUMN low_sessions;

DELETE FROM business_role_permissions WHERE permission_code = 'member_plans.manage';
DELETE FROM business_role_template_permissions WHERE permission_code = 'member_plans.manage';
DELETE FROM business_permissions WHERE code = 'member_plans.manage';
