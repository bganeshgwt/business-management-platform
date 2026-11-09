-- Up Migration
-- A membership a company pays for (sold from the company's quotation): the
-- bill is the company's (its name and GSTIN, on its dues), the membership the
-- member's. `paid_by_contact_id` names the company; the membership's own bill
-- is then that company's, never anyone else's. Without it, as before, a
-- membership is sold on its member's own bill.

ALTER TABLE member_memberships ADD COLUMN paid_by_contact_id BIGINT;
ALTER TABLE member_memberships
  ADD CONSTRAINT member_memberships_paid_by_fkey FOREIGN KEY (business_id, paid_by_contact_id) REFERENCES business_contacts(business_id, id),
  ADD CONSTRAINT member_memberships_paid_by CHECK (paid_by_contact_id IS NULL OR (origin = 'sale' AND paid_by_contact_id <> contact_id));
CREATE INDEX member_memberships_paid_by ON member_memberships(business_id, paid_by_contact_id) WHERE paid_by_contact_id IS NOT NULL;

-- A new membership starts running, with nothing used, frozen, moved or given
-- back. A sale is on its member's own bill, or on the bill of the company
-- that pays for it (paid_by_contact_id), on a line of its plan's item (and a
-- joining fee on the same bill); a renewal or an upgrade is of the member's
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
    IF doc.kind IS DISTINCT FROM 'sale' OR doc.contact_id IS DISTINCT FROM COALESCE(NEW.paid_by_contact_id, NEW.contact_id) THEN
      RAISE EXCEPTION 'A membership is sold on its member''s own bill, or on the bill of the company paying for it' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.paid_by_contact_id IS NOT NULL THEN
      RAISE EXCEPTION 'A membership passed on carries on its bill as it was sold' USING ERRCODE = '23514';
    END IF;
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

-- Down Migration
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
DROP INDEX member_memberships_paid_by;
ALTER TABLE member_memberships DROP CONSTRAINT member_memberships_paid_by, DROP CONSTRAINT member_memberships_paid_by_fkey;
ALTER TABLE member_memberships DROP COLUMN paid_by_contact_id;
