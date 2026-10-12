-- Up Migration

-- ===========================================================================
-- Guest book: one way to write a mobile (and a clean-up of the numbers
-- already typed), merging two records of the same guest, business details for
-- GST invoices, staff tags, marketing consent and erasure on request, and
-- complaints tied to a bill with a record of what the guest was given.
-- ===========================================================================

-- --- New guest details -------------------------------------------------------
ALTER TABLE customers
  -- A corporate guest's bill in their company's name, with its GSTIN, so they
  -- can claim input tax credit. The format is checked here; the check
  -- character and the state code are checked by the API (utils/gstin.js).
  ADD COLUMN company_name        VARCHAR(150),
  ADD COLUMN gstin               VARCHAR(15)
             CONSTRAINT chk_customers_gstin_format
             CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  -- What the floor needs to know at a glance. A fixed list, so "VIP", "vip"
  -- and "V.I.P." cannot become three tags that each filter a third of the
  -- regulars.
  ADD COLUMN tags                TEXT[]        NOT NULL DEFAULT '{}'
             CONSTRAINT chk_customers_tags
             CHECK (tags <@ ARRAY['vip', 'allergy', 'jain', 'vegan', 'corporate', 'family', 'blogger']::TEXT[]),
  -- Said by the guest, repeated to the kitchen: "peanuts", "no shellfish".
  ADD COLUMN allergies           VARCHAR(300),
  -- The DPDP Act 2023: a guest is sent offers only if they said yes. Who
  -- recorded the answer, and when, is kept with it.
  ADD COLUMN marketing_opt_in    BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN marketing_opt_in_at TIMESTAMPTZ,
  ADD COLUMN marketing_opt_in_by BIGINT        REFERENCES users(id),
  -- Set by the mobile clean-up below when two records turned out to hold the
  -- same number: this one is probably the same person as that one, waiting for
  -- someone to merge them (or to say they are not).
  ADD COLUMN duplicate_of        BIGINT        REFERENCES customers(id) ON DELETE SET NULL,
  -- A guest who asked for their data to be deleted. The record stays so the
  -- bills and visit counts on it still add up, but with nothing personal left.
  ADD COLUMN erased_at           TIMESTAMPTZ,
  ADD COLUMN erased_by           BIGINT        REFERENCES users(id);

-- The guest book is read a page at a time, in name order.
CREATE INDEX idx_customers_restaurant_name ON customers (restaurant_id, name);
CREATE INDEX idx_customers_duplicate_of ON customers (duplicate_of) WHERE duplicate_of IS NOT NULL;

-- --- One way to write a mobile -------------------------------------------------
-- Until now a mobile was stored exactly as typed, so 9876543210, +91 98765
-- 43210 and 098765-43210 were three different guests: points split across
-- them, the till found the wrong one, and a campaign would reach one person
-- three times. From now on an Indian mobile is stored as its 10 digits and a
-- foreign one as "+" and digits (utils/phone.js). This rewrites the numbers
-- already on file the same way.

-- What each mobile was before the clean-up, so nothing staff typed is lost,
-- the duplicates screen can show the number as it was entered, and the
-- clean-up can be undone.
CREATE TABLE customer_mobile_cleanup (
  id            BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id   BIGINT       NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  old_mobile    VARCHAR(20),
  old_notes     TEXT,
  -- tidied:        rewritten in the one format
  -- duplicate:     another guest already had this number; left blank here and
  --                marked duplicate_of that guest
  -- not_a_mobile:  not a phone number at all ("call me", 9 digits); moved into
  --                the guest's notes so a person can fix it
  outcome       VARCHAR(20)  NOT NULL
                CHECK (outcome IN ('tidied', 'duplicate', 'not_a_mobile')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_customer_mobile_cleanup_customer ON customer_mobile_cleanup (customer_id);

-- The same rule as utils/phone.js normaliseMobile, for this clean-up only
-- (pg_temp: it disappears with the session).
CREATE FUNCTION pg_temp.canonical_mobile(raw TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  typed  TEXT := btrim(COALESCE(raw, ''));
  digits TEXT;
  abroad BOOLEAN;
BEGIN
  IF typed = '' OR typed !~ '^[+0-9 ().-]+$' THEN
    RETURN NULL;
  END IF;

  digits := regexp_replace(typed, '[^0-9]', '', 'g');
  abroad := typed ~ '^\(?\s*\+';

  IF NOT abroad AND left(digits, 2) = '00' THEN
    digits := substr(digits, 3);
    abroad := TRUE;
  END IF;

  IF abroad THEN
    -- "+98765 43210": the 91 was left out. Only a handful of countries have
    -- mobiles that are 10 digits with their code (Singapore, the Maldives...).
    IF digits ~ '^[6-9][0-9]{9}$'
       AND digits !~ '^(65[89][0-9]{7}|960[79][0-9]{6}|9613[0-9]{6}|642[0-9]{7}|959[0-9]{7}|679[2789][0-9]{6}|673[78][0-9]{6})$' THEN
      RETURN digits;
    END IF;

    -- No country whose code starts 7, 8 or 9 has a mobile under 10 digits
    -- with the code: "+98765 4321" is a slip, not a number from abroad.
    IF left(digits, 2) <> '91' THEN
      IF ('+' || digits) ~ '^\+([1-6][0-9]{7,14}|[789][0-9]{9,14})$' THEN
        RETURN '+' || digits;
      END IF;
      RETURN NULL;
    END IF;

    digits := substr(digits, 3);

    IF length(digits) = 11 AND left(digits, 1) = '0' THEN
      digits := substr(digits, 2);
    END IF;
  ELSIF length(digits) = 12 AND left(digits, 2) = '91' THEN
    digits := substr(digits, 3);
  ELSIF length(digits) = 11 AND left(digits, 1) = '0' THEN
    digits := substr(digits, 2);
  END IF;

  IF digits ~ '^[6-9][0-9]{9}$' THEN
    RETURN digits;
  END IF;

  RETURN NULL;
END;
$$;

CREATE TEMP TABLE mobile_plan AS
SELECT c.id,
       c.restaurant_id,
       c.mobile AS old_mobile,
       c.notes AS old_notes,
       pg_temp.canonical_mobile(c.mobile) AS canonical,
       (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS order_count,
       NULL::BIGINT AS keeper_id
FROM customers c
WHERE c.mobile IS NOT NULL;

-- When several records share a number once it is written one way, the one
-- the guest actually uses keeps it: most orders, then the oldest record. The
-- others are left for a manager to merge (Customers → Possible duplicates);
-- two different names on one number can be a family, and only a person can
-- tell.
UPDATE mobile_plan p
SET keeper_id = k.id
FROM (
  SELECT DISTINCT ON (restaurant_id, canonical) restaurant_id, canonical, id
  FROM mobile_plan
  WHERE canonical IS NOT NULL
  ORDER BY restaurant_id, canonical, order_count DESC, id
) k
WHERE k.restaurant_id = p.restaurant_id AND k.canonical = p.canonical;

INSERT INTO customer_mobile_cleanup (restaurant_id, customer_id, old_mobile, old_notes, outcome)
SELECT restaurant_id, id, old_mobile, old_notes,
       CASE WHEN canonical IS NULL THEN 'not_a_mobile'
            WHEN keeper_id <> id THEN 'duplicate'
            ELSE 'tidied' END
FROM mobile_plan
WHERE canonical IS NULL OR keeper_id <> id OR old_mobile <> canonical;

-- Blanks first, so no rewritten number collides with one about to be cleared.
UPDATE customers c
SET mobile = NULL,
    notes = CONCAT_WS(E'\n', NULLIF(c.notes, ''),
                      'Mobile on file was not a phone number: "' || p.old_mobile || '"')
FROM mobile_plan p
WHERE p.id = c.id AND p.canonical IS NULL;

UPDATE customers c
SET mobile = NULL,
    duplicate_of = p.keeper_id
FROM mobile_plan p
WHERE p.id = c.id AND p.canonical IS NOT NULL AND p.keeper_id <> p.id;

UPDATE customers c
SET mobile = p.canonical
FROM mobile_plan p
WHERE p.id = c.id AND p.keeper_id = p.id AND p.old_mobile <> p.canonical;

DROP TABLE mobile_plan;
DROP FUNCTION pg_temp.canonical_mobile(TEXT);

-- The same ten digits in both forms: "+9598473967" (a number from Myanmar)
-- and 9598473967 (an Indian mobile in the 959 series). Nearly always one
-- guest whose number was once typed with "+" and no 91, so the "+" record is
-- listed under Possible duplicates of the Indian one. It keeps its number
-- until someone merges them, or says they are two people.
UPDATE customers d
SET duplicate_of = k.id
FROM customers k
WHERE k.restaurant_id = d.restaurant_id
  AND k.id <> d.id
  AND d.duplicate_of IS NULL
  AND d.mobile ~ '^\+[6-9][0-9]{9}$'
  AND k.mobile = SUBSTR(d.mobile, 2);

-- And from now on, nothing else gets in, whichever screen or script writes it.
-- A foreign number is "+" and its country code, never +91: an Indian mobile
-- is always its plain 10 digits, so it has exactly one way to be written.
-- "+" and 10 digits that read as an Indian mobile is the same guest's number
-- with the 91 left out, unless it is one of the few 10-digit mobiles abroad.
ALTER TABLE customers
  ADD CONSTRAINT chk_customers_mobile_format
  CHECK (mobile IS NULL
         OR mobile ~ '^[6-9][0-9]{9}$'
         OR (mobile ~ '^\+(?!91)([1-6][0-9]{7,14}|[789][0-9]{9,14})$'
             AND (mobile !~ '^\+[6-9][0-9]{9}$'
                  OR mobile ~ '^\+(65[89][0-9]{7}|960[79][0-9]{6}|9613[0-9]{6}|642[0-9]{7}|959[0-9]{7}|679[2789][0-9]{6}|673[78][0-9]{6})$')));

-- --- Nothing new is linked to an erased guest ------------------------------------
-- A guest who asked for their data to be erased keeps a nameless record, so
-- their past bills and visits still add up. Nothing new may be attached to
-- it: an order linked to it would earn it points and print its old name, a
-- booking would open an order in its name, feedback would put a name and a
-- number back on it. The screens and the guest book's own API refuse such a
-- link with a sentence; this is the last line, for any module that writes a
-- guest's id: the new row carries on as a walk-in (no guest), with the
-- record's "Erased guest #…" label taken off an order. Rows already linked
-- are left alone, so a paid bill's order keeps its guest.
CREATE FUNCTION keep_erased_guests_unlinked() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.customer_id IS DISTINCT FROM OLD.customer_id)
     AND EXISTS (SELECT 1 FROM customers c WHERE c.id = NEW.customer_id AND c.erased_at IS NOT NULL) THEN
    IF TG_TABLE_NAME = 'orders' AND to_jsonb(NEW) ->> 'customer_name' = 'Erased guest #' || NEW.customer_id THEN
      NEW := jsonb_populate_record(NEW, '{"customer_name": null}'::jsonb);
    END IF;
    NEW := jsonb_populate_record(NEW, '{"customer_id": null}'::jsonb);
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_orders_erased_guest
BEFORE INSERT OR UPDATE OF customer_id ON orders
FOR EACH ROW EXECUTE FUNCTION keep_erased_guests_unlinked();

CREATE TRIGGER trg_reservations_erased_guest
BEFORE INSERT OR UPDATE OF customer_id ON reservations
FOR EACH ROW EXECUTE FUNCTION keep_erased_guests_unlinked();

CREATE TRIGGER trg_waitlist_entries_erased_guest
BEFORE INSERT OR UPDATE OF customer_id ON waitlist_entries
FOR EACH ROW EXECUTE FUNCTION keep_erased_guests_unlinked();

CREATE TRIGGER trg_feedback_erased_guest
BEFORE INSERT OR UPDATE OF customer_id ON feedback
FOR EACH ROW EXECUTE FUNCTION keep_erased_guests_unlinked();

CREATE TRIGGER trg_complaints_erased_guest
BEFORE INSERT OR UPDATE OF customer_id ON complaints
FOR EACH ROW EXECUTE FUNCTION keep_erased_guests_unlinked();

-- --- Merging two records of the same guest --------------------------------------
-- One row per merge: which record was folded into which, what it was called,
-- and how much moved. The merged record itself is deleted, so it is named here
-- rather than referenced.
CREATE TABLE customer_merges (
  id                 BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id      BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  kept_customer_id   BIGINT       REFERENCES customers(id) ON DELETE SET NULL,
  merged_customer_id BIGINT       NOT NULL,
  merged_name        VARCHAR(150),
  merged_mobile      VARCHAR(20),
  points_moved       INTEGER      NOT NULL DEFAULT 0,
  -- How many orders, feedback entries, complaints, points entries and
  -- bookings moved across, by table.
  records_moved      JSONB        NOT NULL DEFAULT '{}'::JSONB,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by         BIGINT       REFERENCES users(id)
);

CREATE INDEX idx_customer_merges_kept ON customer_merges (restaurant_id, kept_customer_id);

-- --- Complaints: the bill, and what the guest was given ----------------------------
ALTER TABLE complaints
  -- A billing complaint cannot be checked without the bill, and a food one is
  -- easier to settle with the order in front of you.
  ADD COLUMN bill_id            BIGINT        REFERENCES bills(id) ON DELETE SET NULL,
  ADD COLUMN order_id           BIGINT        REFERENCES orders(id) ON DELETE SET NULL,
  -- What the guest got to put it right, and what it cost the restaurant. A
  -- record only: the refund itself is given from Bills, points from the
  -- guest's card.
  ADD COLUMN compensation_type  VARCHAR(20)
             CHECK (compensation_type IN ('apology', 'replaced', 'removed', 'discount',
                                          'complimentary', 'refund', 'voucher', 'points')),
  ADD COLUMN compensation_value NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (compensation_value >= 0),
  ADD COLUMN compensation_notes VARCHAR(300);

CREATE INDEX idx_complaints_bill ON complaints (restaurant_id, bill_id) WHERE bill_id IS NOT NULL;
CREATE INDEX idx_complaints_order ON complaints (restaurant_id, order_id) WHERE order_id IS NOT NULL;

-- --- Permissions -----------------------------------------------------------------
-- Merging moves one guest's points onto another, and erasing wipes a guest's
-- details for good. Neither is a till-side job, so neither rides on
-- customers.manage (which every cashier holds): owners and managers get them,
-- and so does any restaurant role that already runs the restaurant's access
-- (it manages users and roles). Both are new abilities, so other custom roles
-- are left for the owner to decide.
INSERT INTO permissions (code, module, name) VALUES
  ('customers.merge', 'crm', 'Merge two records of the same guest'),
  ('customers.erase', 'crm', 'Erase a guest''s personal details when they ask');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('customers.merge', 'customers.erase')
WHERE (r.restaurant_id IS NULL AND r.is_system = TRUE
       AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER'))
   OR (r.restaurant_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM role_permissions x JOIN permissions xp ON xp.id = x.permission_id
                   WHERE x.role_id = r.id AND xp.code = 'users.manage')
       AND EXISTS (SELECT 1 FROM role_permissions x JOIN permissions xp ON xp.id = x.permission_id
                   WHERE x.role_id = r.id AND xp.code = 'roles.manage'))
ON CONFLICT DO NOTHING;

-- Who reads guests' full mobiles, emails and addresses. Staff who look after
-- guests at the till (customers.manage, every cashier) could otherwise page
-- through the whole guest book and copy every regular's number: the list a
-- competitor would pay for, and what the DPDP Act asks a restaurant to
-- protect. They see "XXXXXX3210" instead, and still get a guest in full when
-- they type that guest's whole number (the guest is in front of them, or on
-- the phone) or open one guest's number on purpose, which is logged.
-- Owners and managers see everything, and so does any restaurant role that
-- can already export the guest list or runs the restaurant's access.
INSERT INTO permissions (code, module, name) VALUES
  ('customers.contact', 'crm', 'See every guest''s full mobile, email and address');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'customers.contact'
WHERE (r.restaurant_id IS NULL AND r.is_system = TRUE
       AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER'))
   OR (r.restaurant_id IS NOT NULL
       AND (EXISTS (SELECT 1 FROM role_permissions x JOIN permissions xp ON xp.id = x.permission_id
                    WHERE x.role_id = r.id AND xp.code = 'customers.export')
            OR (EXISTS (SELECT 1 FROM role_permissions x JOIN permissions xp ON xp.id = x.permission_id
                        WHERE x.role_id = r.id AND xp.code = 'users.manage')
                AND EXISTS (SELECT 1 FROM role_permissions x JOIN permissions xp ON xp.id = x.permission_id
                            WHERE x.role_id = r.id AND xp.code = 'roles.manage'))))
ON CONFLICT DO NOTHING;

-- Down Migration

DROP TRIGGER IF EXISTS trg_complaints_erased_guest ON complaints;
DROP TRIGGER IF EXISTS trg_feedback_erased_guest ON feedback;
DROP TRIGGER IF EXISTS trg_waitlist_entries_erased_guest ON waitlist_entries;
DROP TRIGGER IF EXISTS trg_reservations_erased_guest ON reservations;
DROP TRIGGER IF EXISTS trg_orders_erased_guest ON orders;
DROP FUNCTION IF EXISTS keep_erased_guests_unlinked();

DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions
                        WHERE code IN ('customers.merge', 'customers.erase', 'customers.contact'));
DELETE FROM permissions WHERE code IN ('customers.merge', 'customers.erase', 'customers.contact');

DROP INDEX IF EXISTS idx_complaints_order;
DROP INDEX IF EXISTS idx_complaints_bill;

ALTER TABLE complaints
  DROP COLUMN IF EXISTS compensation_notes,
  DROP COLUMN IF EXISTS compensation_value,
  DROP COLUMN IF EXISTS compensation_type,
  DROP COLUMN IF EXISTS order_id,
  DROP COLUMN IF EXISTS bill_id;

-- The mobiles as they were typed, for every guest still on file. A merged
-- record is gone and stays gone; its history is on the guest it joined.
-- Tidied numbers go back first: a duplicate's old number may be the tidied
-- form its twin holds until then. A number someone has since given to a new
-- guest is left where it is rather than failing the whole rollback.
--
-- A guest who absorbed a merge made before merging stopped carrying the
-- folded record's clean-up rows along may hold a row that was never theirs
-- (customer_merges.records_moved names the table when that happened). Which
-- row is theirs cannot be told apart, so such a guest keeps the number and
-- notes they have now (the same number, in the one format) rather than be
-- given the folded record's old spelling or its notes.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS chk_customers_mobile_format;

CREATE TEMP TABLE cleanup_restorable AS
SELECT b.*
FROM customer_mobile_cleanup b
WHERE NOT EXISTS (SELECT 1 FROM customer_merges m
                  WHERE m.kept_customer_id = b.customer_id
                    AND m.records_moved ? 'customer_mobile_cleanup');

UPDATE customers c
SET mobile = b.old_mobile
FROM cleanup_restorable b
WHERE b.customer_id = c.id AND b.outcome = 'tidied'
  AND NOT EXISTS (SELECT 1 FROM customers x
                  WHERE x.restaurant_id = c.restaurant_id AND x.mobile = b.old_mobile AND x.id <> c.id);

UPDATE customers c
SET mobile = CASE WHEN EXISTS (SELECT 1 FROM customers x
                               WHERE x.restaurant_id = c.restaurant_id AND x.mobile = b.old_mobile
                                 AND x.id <> c.id)
                  THEN c.mobile ELSE b.old_mobile END,
    notes = CASE WHEN b.outcome = 'not_a_mobile' THEN b.old_notes ELSE c.notes END
FROM cleanup_restorable b
WHERE b.customer_id = c.id AND b.outcome IN ('duplicate', 'not_a_mobile');

DROP TABLE cleanup_restorable;
DROP TABLE IF EXISTS customer_mobile_cleanup;
DROP TABLE IF EXISTS customer_merges;

DROP INDEX IF EXISTS idx_customers_duplicate_of;
DROP INDEX IF EXISTS idx_customers_restaurant_name;

ALTER TABLE customers
  DROP COLUMN IF EXISTS erased_by,
  DROP COLUMN IF EXISTS erased_at,
  DROP COLUMN IF EXISTS duplicate_of,
  DROP COLUMN IF EXISTS marketing_opt_in_by,
  DROP COLUMN IF EXISTS marketing_opt_in_at,
  DROP COLUMN IF EXISTS marketing_opt_in,
  DROP COLUMN IF EXISTS allergies,
  DROP COLUMN IF EXISTS tags,
  DROP COLUMN IF EXISTS gstin,
  DROP COLUMN IF EXISTS company_name;
