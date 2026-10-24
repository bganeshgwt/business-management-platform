-- Up Migration
-- A gym's, studio's or coaching centre's own tools: plans by days, months or
-- sessions; memberships sold on a bill with their terms kept as sold, renewed,
-- upgraded with pro-rata credit, frozen, transferred, or cancelled with a
-- pro-rata refund; check-ins at the front desk; fees in instalments; and the
-- lists of memberships running out and fees falling due.
--
-- Plans & memberships (module "member_plans", on for type "memberships"):
--   member_plan_types      a plan: by days or months, a pack of sessions, or
--                          both (a pack to use within a time); its price item
--                          (a service of the catalogue, so its GST, SAC and
--                          slab come from there: 5% without input tax credit
--                          for a gym, yoga or fitness centre, 18% for coaching
--                          and classes), a joining fee item if any, how many
--                          days it may be frozen in how many freezes, the grace
--                          days after it runs out, whether it can be passed to
--                          another member, and its refund policy (its current
--                          version). Switched off, never deleted.
--   member_plan_policies   every version of a plan's refund policy, as it was
--                          written; a membership keeps the version it was sold
--                          with.
--   member_profiles        a member's code (M0001), printed on their card and
--                          typed or scanned at the desk.
--   member_memberships     a membership (MS/2627/0001): the member, the plan and
--                          its terms as sold (the price as billed, the policy
--                          version, the freeze, grace and transfer rules), the
--                          start, the last day as sold and as frozen days move
--                          it, the sessions of a pack and those used, the bill
--                          line that sold it, and how it began (a sale, a
--                          renewal starting after another, an upgrade, or a
--                          transfer from another member). It runs to its end
--                          unless it is closed: cancelled, transferred or
--                          upgraded, with its last day. A cancellation or an
--                          upgrade credits the unused part, worked out from the
--                          days or sessions used, on a credit note against its
--                          bill; a cancellation's refund goes back through the
--                          core with a manager's approval.
--   member_freezes         each freeze: from a day for planned days, ended
--                          early when the member comes back; the frozen days
--                          move the membership's last day.
--   member_instalments     a membership's fee in instalments: amounts and due
--                          days adding up to its bill; payments on the bill
--                          (collections) cover them in order.
--   member_checkins        every check-in at the desk, let in or turned away
--                          with the reason; a pack loses one session a day.
--   member_events          everything that happened to a membership, as it was
--                          written.
--   member_reminders       each renewal or fees reminder given.
--   member_settings        when overdue fees turn a member away at check-in (7
--                          days until changed), and the last member code given.
-- A plan's item goes on a bill only from Members & plans, which makes the
-- membership with it; the bill lines that sold a membership come back only on
-- the credit note its cancellation or upgrade makes.

-- --- Module, permissions and roles ------------------------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('member_plans', 'Plans & memberships', 'Plans by days, months or sessions with a refund policy kept in versions; memberships sold on a bill with their terms kept, renewed, upgraded with pro-rata credit, frozen, transferred or cancelled with a pro-rata refund; check-ins at the desk; fees in instalments; renewals and fees due.', 'optional', 237);

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('member_plans', 'catalog'), ('member_plans', 'contacts'), ('member_plans', 'sales');

INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES ('member_plans', 'memberships', TRUE);

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('member_plans', 'view', 'See plans, members and their memberships, check-ins, renewals and fees due', 510),
 ('member_plans', 'create', 'Check members in, and sell and renew memberships', 511),
 ('member_plans', 'edit', 'Set up plans, and freeze, transfer and upgrade memberships', 512),
 ('member_plans', 'approve', 'Approve what a cancelled membership gives back', 513),
 ('member_plans', 'cancel', 'Cancel memberships', 514),
 ('member_plans', 'refund', 'Give back the unused part of a cancelled membership', 515),
 ('member_plans', 'export', 'Export members, memberships and check-ins', 516)
) AS p(module_code, action, name, sort_order);

-- A trainer of a gym or studio: sees members, their plans and check-ins,
-- checks members in and marks their sessions done; no money.
INSERT INTO business_role_templates (code, name, description, full_access, sort_order, business_types) VALUES
 ('trainer', 'Trainer', 'Sees members, their plans and check-ins, checks members in and marks personal-training sessions done or missed. Sees no prices and takes no money.', FALSE, 38, ARRAY['memberships']);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code = 'member_plans'
UNION ALL SELECT 'cashier', unnest(ARRAY['member_plans.view', 'member_plans.create', 'member_plans.edit'])
UNION ALL SELECT 'stock_keeper', unnest(ARRAY['member_plans.view'])
UNION ALL SELECT 'accountant', unnest(ARRAY['member_plans.view', 'member_plans.export'])
UNION ALL SELECT 'viewer', unnest(ARRAY['member_plans.view', 'member_plans.export'])
UNION ALL SELECT 'trainer', unnest(ARRAY['member_plans.view', 'member_plans.create', 'appointments.view', 'appointments.edit']);

-- Existing businesses' copies of the shared templates (harmless where the
-- module cannot be switched on; keeps "role copy = template"), and the new
-- role in existing gyms, studios and coaching centres.
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code = 'member_plans'
WHERE NOT r.full_access AND r.template_code IN ('manager', 'cashier', 'stock_keeper', 'accountant', 'viewer')
ON CONFLICT DO NOTHING;
SELECT business_seed_roles(id) FROM businesses WHERE business_type = 'memberships';

-- Existing gyms, studios and coaching centres get the tool a new one starts
-- with (where what it needs is on).
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, t.module_code
FROM businesses b
JOIN platform_module_business_types t ON t.business_type = b.business_type AND t.enabled_by_default
WHERE t.module_code = 'member_plans'
  AND NOT EXISTS (SELECT 1 FROM platform_module_dependencies d WHERE d.module_code = t.module_code
    AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = d.requires_module_code))
ON CONFLICT DO NOTHING;

-- Memberships are numbered (MS/2627/0001). The kinds list is widened by
-- reading the current one, so kinds other migrations added are kept.
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  IF NOT 'membership' = ANY(kinds) THEN kinds := array_append(kinds, 'membership'::text); END IF;
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;

-- History is kept as it was written.
CREATE FUNCTION member_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'member_plan_policies' THEN
    RAISE EXCEPTION 'A version of a refund policy is kept as it was written: write a new version instead' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'member_instalments' THEN
    RAISE EXCEPTION 'A membership''s instalments are kept as they were set' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'member_checkins' THEN
    RAISE EXCEPTION 'A check-in is kept as it was recorded' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'member_events' THEN
    RAISE EXCEPTION 'A membership''s history is kept as it was written' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'A reminder is kept as it was given' USING ERRCODE = '23514';
END $$;

-- --- Settings ------------------------------------------------------------------------------------

-- One row per business, made when the settings are first saved or the first
-- member code is given.
CREATE TABLE member_settings (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id),
  -- A member whose fees are overdue by more than this many days is turned
  -- away at check-in (empty: never).
  dues_block_days SMALLINT DEFAULT 7 CHECK (dues_block_days BETWEEN 0 AND 365),
  -- The last member code given out (M0001, M0002 …).
  last_member_no INTEGER NOT NULL DEFAULT 0 CHECK (last_member_no >= 0),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- Plans ---------------------------------------------------------------------------------------

CREATE TABLE member_plan_types (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(100) NOT NULL CHECK (btrim(name) <> ''),
  -- By days or months, a pack of sessions, or a pack to use within a time.
  kind TEXT NOT NULL CHECK (kind IN ('duration', 'sessions', 'both')),
  duration_unit TEXT CHECK (duration_unit IN ('days', 'months')),
  duration SMALLINT CHECK (duration > 0),
  sessions SMALLINT CHECK (sessions BETWEEN 1 AND 1000),
  -- The service item the plan is sold as, and the joining fee's item.
  price_sku_id BIGINT NOT NULL,
  joining_sku_id BIGINT,
  -- Frozen for at most this many days in all, in at most this many freezes.
  max_freeze_days SMALLINT NOT NULL DEFAULT 0 CHECK (max_freeze_days BETWEEN 0 AND 365),
  max_freezes SMALLINT NOT NULL DEFAULT 0 CHECK (max_freezes BETWEEN 0 AND 12),
  -- Days after the last day on which the member is still let in.
  grace_days SMALLINT NOT NULL DEFAULT 0 CHECK (grace_days BETWEEN 0 AND 90),
  -- Whether a membership of the plan can be passed to another member.
  transferable BOOLEAN NOT NULL DEFAULT FALSE,
  -- The version of the refund policy a sale now gets (member_plan_policies).
  policy_version SMALLINT NOT NULL DEFAULT 1 CHECK (policy_version >= 1),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, price_sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, joining_sku_id) REFERENCES catalog_skus(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, price_sku_id),
  CHECK ((kind = 'sessions') = (duration IS NULL)),
  CHECK ((duration IS NULL) = (duration_unit IS NULL)),
  CHECK ((kind = 'duration') = (sessions IS NULL)),
  CHECK (duration_unit IS DISTINCT FROM 'days' OR duration <= 3660),
  CHECK (duration_unit IS DISTINCT FROM 'months' OR duration <= 120),
  CHECK (joining_sku_id IS DISTINCT FROM price_sku_id),
  CHECK ((max_freezes = 0) = (max_freeze_days = 0)),
  -- A pack with no end date is never frozen.
  CHECK (kind <> 'sessions' OR max_freezes = 0)
);
CREATE UNIQUE INDEX member_plan_types_name ON member_plan_types(business_id, lower(name));

-- Every version of a plan's refund policy, as it was written.
CREATE TABLE member_plan_policies (
  business_id BIGINT NOT NULL,
  plan_id BIGINT NOT NULL,
  version SMALLINT NOT NULL CHECK (version >= 1),
  policy TEXT NOT NULL CHECK (btrim(policy) <> '' AND length(policy) <= 4000),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, plan_id, version),
  FOREIGN KEY (business_id, plan_id) REFERENCES member_plan_types(business_id, id)
);
CREATE TRIGGER member_plan_policies_append_only BEFORE UPDATE OR DELETE ON member_plan_policies
  FOR EACH ROW EXECUTE FUNCTION member_append_only();
-- The plan's current version is one that was written (checked when the
-- plan and its policy are saved together).
ALTER TABLE member_plan_types ADD CONSTRAINT member_plan_types_policy_fkey FOREIGN KEY (business_id, id, policy_version)
  REFERENCES member_plan_policies(business_id, plan_id, version) DEFERRABLE INITIALLY DEFERRED;

-- A plan is sold as a service of the business (not a kit), its own item; a
-- joining fee is a service too, and never another plan's price item. A plan
-- keeps its price item (its price changes on the item) and is never deleted;
-- its policy goes up one version at a time.
CREATE FUNCTION member_plan_types_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A plan is never deleted; stop selling it instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.price_sku_id <> OLD.price_sku_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'A plan keeps its price item: change the item''s price instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.policy_version <> 1 THEN
    RAISE EXCEPTION 'A new plan starts with the first version of its refund policy' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.policy_version NOT IN (OLD.policy_version, OLD.policy_version + 1) THEN
    RAISE EXCEPTION 'A plan''s refund policy goes up one version at a time' USING ERRCODE = '23514';
  END IF;
  SELECT p.kind, s.is_kit, s.label INTO item FROM catalog_skus s JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
  WHERE s.business_id = NEW.business_id AND s.id = NEW.price_sku_id;
  IF item.kind IS DISTINCT FROM 'service' OR item.is_kit THEN
    RAISE EXCEPTION 'A plan is sold as a service item of this business' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM member_plan_types WHERE business_id = NEW.business_id AND joining_sku_id = NEW.price_sku_id AND id <> NEW.id) THEN
    RAISE EXCEPTION '% is the joining fee of another plan: a plan is sold as its own item', item.label USING ERRCODE = '23514';
  END IF;
  IF NEW.joining_sku_id IS NOT NULL THEN
    SELECT p.kind, s.is_kit, s.label INTO item FROM catalog_skus s JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
    WHERE s.business_id = NEW.business_id AND s.id = NEW.joining_sku_id;
    IF item.kind IS DISTINCT FROM 'service' OR item.is_kit THEN
      RAISE EXCEPTION 'A joining fee is a service item of this business' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM member_plan_types WHERE business_id = NEW.business_id AND price_sku_id = NEW.joining_sku_id) THEN
      RAISE EXCEPTION '% is a plan''s own item, not a joining fee', item.label USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_plan_types_check BEFORE INSERT OR UPDATE OR DELETE ON member_plan_types
  FOR EACH ROW EXECUTE FUNCTION member_plan_types_check();

-- --- Members -------------------------------------------------------------------------------------

-- A member's code, printed on their card and typed or scanned at the desk.
CREATE TABLE member_profiles (
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  member_code VARCHAR(20) NOT NULL CHECK (member_code ~ '^[A-Z0-9][A-Z0-9-]{1,19}$'),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, contact_id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, member_code)
);
CREATE TRIGGER member_profiles_customer BEFORE INSERT OR UPDATE OF contact_id ON member_profiles
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- --- Memberships ---------------------------------------------------------------------------------

CREATE TABLE member_memberships (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  -- Where it was sold.
  location_id BIGINT NOT NULL,
  membership_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  -- The member.
  contact_id BIGINT NOT NULL,
  plan_id BIGINT NOT NULL,
  -- The plan's terms as sold: a later change to the plan never changes them.
  plan_name VARCHAR(100) NOT NULL CHECK (btrim(plan_name) <> ''),
  kind TEXT NOT NULL CHECK (kind IN ('duration', 'sessions', 'both')),
  duration_unit TEXT CHECK (duration_unit IN ('days', 'months')),
  duration SMALLINT CHECK (duration > 0),
  sessions_total SMALLINT CHECK (sessions_total BETWEEN 1 AND 1000),
  sessions_used SMALLINT NOT NULL DEFAULT 0 CHECK (sessions_used >= 0),
  -- The plan's line as billed: its taxable value, GST and rate, and the two
  -- together; and the joining fee billed with it (GST included).
  price NUMERIC(14,2) NOT NULL CHECK (price >= 0),
  price_net NUMERIC(14,2) NOT NULL CHECK (price_net >= 0),
  price_tax NUMERIC(14,2) NOT NULL CHECK (price_tax >= 0),
  tax_rate NUMERIC(5,2) NOT NULL CHECK (tax_rate BETWEEN 0 AND 100),
  joining_fee NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (joining_fee >= 0),
  policy_version SMALLINT NOT NULL,
  max_freeze_days SMALLINT NOT NULL CHECK (max_freeze_days BETWEEN 0 AND 365),
  max_freezes SMALLINT NOT NULL CHECK (max_freezes BETWEEN 0 AND 12),
  grace_days SMALLINT NOT NULL CHECK (grace_days BETWEEN 0 AND 90),
  transferable BOOLEAN NOT NULL,
  -- Its first day, its last day as sold (none for a pack with no end date),
  -- the days it has been frozen, and its last day with them.
  start_on DATE NOT NULL,
  base_end_on DATE,
  frozen_days SMALLINT NOT NULL DEFAULT 0 CHECK (frozen_days >= 0),
  end_on DATE,
  -- How it began: a renewal starting after another, an upgrade of another,
  -- or the rest of another member's membership passed on.
  renewal_of BIGINT,
  upgraded_from BIGINT,
  transferred_from BIGINT,
  -- The bill line that sold it (a transfer keeps the first member's bill).
  document_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  joining_line_id BIGINT,
  -- How it ended early, and its last day counted (the day before its start
  -- when it never began).
  closed TEXT CHECK (closed IN ('cancelled', 'transferred', 'upgraded')),
  closed_on DATE,
  close_reason VARCHAR(300),
  closed_by BIGINT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  close_key UUID,
  close_hash CHAR(64),
  -- What a cancellation or an upgrade gives back: the request key of the
  -- credit note on its bill, the credit note, its value, the money refunded
  -- (a cancellation) and the manager who approved it.
  credit_key UUID,
  return_id BIGINT,
  credit NUMERIC(16,2) CHECK (credit > 0),
  refund_id BIGINT REFERENCES business_refunds(id),
  refunded NUMERIC(16,2) CHECK (refunded > 0),
  approved_by BIGINT REFERENCES users(id),
  notes VARCHAR(500),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, plan_id) REFERENCES member_plan_types(business_id, id),
  FOREIGN KEY (business_id, plan_id, policy_version) REFERENCES member_plan_policies(business_id, plan_id, version),
  FOREIGN KEY (business_id, renewal_of) REFERENCES member_memberships(business_id, id),
  FOREIGN KEY (business_id, upgraded_from) REFERENCES member_memberships(business_id, id),
  FOREIGN KEY (business_id, transferred_from) REFERENCES member_memberships(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  FOREIGN KEY (business_id, joining_line_id) REFERENCES business_document_lines(business_id, id),
  FOREIGN KEY (business_id, return_id) REFERENCES business_returns(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, membership_no),
  UNIQUE (business_id, request_key),
  CHECK ((kind = 'sessions') = (duration IS NULL)),
  CHECK ((duration IS NULL) = (duration_unit IS NULL)),
  CHECK ((kind = 'duration') = (sessions_total IS NULL)),
  CHECK (sessions_total IS NULL OR sessions_used <= sessions_total),
  CHECK (price = price_net + price_tax),
  CHECK ((kind = 'sessions') = (base_end_on IS NULL)),
  CHECK (base_end_on IS NULL OR base_end_on >= start_on),
  CHECK ((base_end_on IS NULL AND end_on IS NULL AND frozen_days = 0) OR end_on = base_end_on + frozen_days),
  CHECK (num_nonnulls(renewal_of, upgraded_from, transferred_from) <= 1),
  CHECK (joining_line_id IS NULL OR joining_line_id <> line_id),
  CHECK (joining_line_id IS NOT NULL OR joining_fee = 0),
  CHECK ((closed IS NULL) = (closed_on IS NULL)),
  CHECK ((closed IS NULL) = (closed_by IS NULL)),
  CHECK ((closed IS NULL) = (closed_at IS NULL)),
  CHECK ((closed IS NULL) = (close_reason IS NULL)),
  CHECK ((closed IS NULL) = (close_key IS NULL)),
  CHECK ((close_key IS NULL) = (close_hash IS NULL)),
  CHECK (closed_on IS NULL OR closed_on >= start_on - 1),
  CHECK (credit_key IS NULL OR closed IN ('cancelled', 'upgraded')),
  CHECK (return_id IS NULL OR credit_key IS NOT NULL),
  CHECK ((return_id IS NULL) = (credit IS NULL)),
  CHECK (refund_id IS NULL OR (closed = 'cancelled' AND return_id IS NOT NULL)),
  CHECK ((refund_id IS NULL) = (refunded IS NULL)),
  CHECK (approved_by IS NULL OR closed = 'cancelled')
);
CREATE INDEX member_memberships_member ON member_memberships(business_id, contact_id, start_on DESC);
CREATE INDEX member_memberships_period ON member_memberships(business_id, created_at DESC);
CREATE INDEX member_memberships_running ON member_memberships(business_id, end_on) WHERE closed IS NULL;
CREATE INDEX member_memberships_plan ON member_memberships(business_id, plan_id);
CREATE INDEX member_memberships_document ON member_memberships(business_id, document_id);
-- One membership per bill line it was sold on (a transfer continues another's).
CREATE UNIQUE INDEX member_memberships_line ON member_memberships(business_id, line_id) WHERE transferred_from IS NULL;
CREATE INDEX member_memberships_joining_line ON member_memberships(business_id, joining_line_id) WHERE joining_line_id IS NOT NULL;
CREATE UNIQUE INDEX member_memberships_upgraded_from ON member_memberships(business_id, upgraded_from) WHERE upgraded_from IS NOT NULL;
CREATE UNIQUE INDEX member_memberships_transferred_from ON member_memberships(business_id, transferred_from) WHERE transferred_from IS NOT NULL;
CREATE TRIGGER member_memberships_customer BEFORE INSERT ON member_memberships
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- A new membership starts running, with nothing used, frozen or given back;
-- it is sold on its member's own bill, on a line of its plan's item (and a
-- joining fee on the same bill); a renewal or an upgrade is of the member's
-- own membership (an upgrade of one closed as upgraded); a transfer
-- continues a membership closed as transferred, on that membership's bill.
CREATE FUNCTION member_memberships_insert_check() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER member_memberships_insert_check BEFORE INSERT ON member_memberships
  FOR EACH ROW EXECUTE FUNCTION member_memberships_insert_check();

-- A membership is never deleted. It keeps its member, plan, terms, start and
-- bill as sold; its frozen days follow its freezes; its sessions used only
-- go up, by its check-ins; it is closed once (cancelled, transferred or
-- upgraded) and then changes no more, but for what the closing gave back,
-- written once.
CREATE FUNCTION member_memberships_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER member_memberships_guard BEFORE UPDATE OR DELETE ON member_memberships
  FOR EACH ROW EXECUTE FUNCTION member_memberships_guard();

-- The bill lines that sold a membership (its plan and its joining fee) come
-- back only on the credit note its cancellation or upgrade makes, worked out
-- from the days or sessions used.
CREATE FUNCTION member_plan_line_return() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m RECORD; credit_note UUID;
BEGIN
  SELECT membership_no, credit_key INTO m FROM member_memberships
  WHERE business_id = NEW.business_id AND (line_id = NEW.line_id OR joining_line_id = NEW.line_id) AND transferred_from IS NULL;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT request_key INTO credit_note FROM business_returns WHERE business_id = NEW.business_id AND id = NEW.return_id;
  IF m.credit_key IS DISTINCT FROM credit_note THEN
    RAISE EXCEPTION 'This line sold membership %. It is credited only when the membership is cancelled or upgraded on the member''s page, by the days or sessions used.', m.membership_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_return_lines_member_plan BEFORE INSERT ON business_return_lines
  FOR EACH ROW EXECUTE FUNCTION member_plan_line_return();

-- --- Freezes -------------------------------------------------------------------------------------

-- A freeze from a day for planned days; ended early when the member comes
-- back (it then counts the days up to that day, none when called off before
-- it began). Its days move the membership's last day.
CREATE TABLE member_freezes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  membership_id BIGINT NOT NULL,
  starts_on DATE NOT NULL,
  planned_days SMALLINT NOT NULL CHECK (planned_days BETWEEN 1 AND 365),
  days SMALLINT NOT NULL CHECK (days BETWEEN 0 AND planned_days),
  reason VARCHAR(300),
  ended_on DATE,
  ended_by BIGINT REFERENCES users(id),
  ended_at TIMESTAMPTZ,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, membership_id) REFERENCES member_memberships(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  CHECK ((ended_on IS NULL) = (ended_by IS NULL)),
  CHECK ((ended_on IS NULL) = (ended_at IS NULL)),
  CHECK (ended_on IS NOT NULL OR days = planned_days),
  CHECK (ended_on IS NULL OR days = GREATEST(0, ended_on - starts_on))
);
CREATE INDEX member_freezes_membership ON member_freezes(business_id, membership_id, starts_on);

-- A freeze is of a running membership with an end date, starts between its
-- first and last day and not before today (the business's date), never
-- overlaps another, and stays within the plan's limits (as sold): how many
-- freezes and how many days in all. It is never deleted; ending it early
-- only lowers its days, once.
CREATE FUNCTION member_freezes_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m RECORD; today DATE; taken INT; frozen INT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A freeze is never deleted; end it early instead' USING ERRCODE = '23514';
  END IF;
  SELECT x.membership_no, x.closed, x.start_on, x.end_on, x.max_freezes, x.max_freeze_days, (now() AT TIME ZONE b.timezone)::date AS today INTO m
  FROM member_memberships x JOIN businesses b ON b.id = x.business_id WHERE x.business_id = NEW.business_id AND x.id = NEW.membership_id FOR UPDATE OF x;
  IF m.closed IS NOT NULL THEN
    RAISE EXCEPTION 'Membership % was % and is not frozen any more', m.membership_no, m.closed USING ERRCODE = '23514';
  END IF;
  today := m.today;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.membership_id <> OLD.membership_id OR NEW.starts_on <> OLD.starts_on OR NEW.planned_days <> OLD.planned_days OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.request_key <> OLD.request_key OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'A freeze keeps its first day and its planned days' USING ERRCODE = '23514';
    END IF;
    IF OLD.ended_on IS NOT NULL THEN
      RAISE EXCEPTION 'This freeze has already ended' USING ERRCODE = '23514';
    END IF;
    IF NEW.ended_on IS NULL OR NEW.ended_on <> today THEN
      RAISE EXCEPTION 'A freeze ends early on the day the member comes back (today)' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF m.end_on IS NULL THEN
    RAISE EXCEPTION 'Membership % is a pack of sessions with no end date: it is not frozen', m.membership_no USING ERRCODE = '23514';
  END IF;
  IF NEW.ended_on IS NOT NULL THEN
    RAISE EXCEPTION 'A freeze starts with its planned days' USING ERRCODE = '23514';
  END IF;
  IF NEW.starts_on < today THEN
    RAISE EXCEPTION 'A freeze starts today or later' USING ERRCODE = '23514';
  END IF;
  IF NEW.starts_on < m.start_on OR NEW.starts_on > m.end_on THEN
    RAISE EXCEPTION 'A freeze of membership % starts between its first day (%) and its last (%)', m.membership_no,
      to_char(m.start_on, 'DD Mon YYYY'), to_char(m.end_on, 'DD Mon YYYY') USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM member_freezes f WHERE f.business_id = NEW.business_id AND f.membership_id = NEW.membership_id AND f.days > 0
             AND f.starts_on <= NEW.starts_on + NEW.days - 1 AND NEW.starts_on <= f.starts_on + f.days - 1) THEN
    RAISE EXCEPTION 'Membership % is already frozen on some of those days', m.membership_no USING ERRCODE = '23514';
  END IF;
  IF m.max_freezes = 0 THEN
    RAISE EXCEPTION 'The plan of membership % is not frozen', m.membership_no USING ERRCODE = '23514';
  END IF;
  SELECT count(*) FILTER (WHERE days > 0)::int, COALESCE(sum(days), 0)::int INTO taken, frozen
  FROM member_freezes WHERE business_id = NEW.business_id AND membership_id = NEW.membership_id;
  IF taken + 1 > m.max_freezes THEN
    RAISE EXCEPTION 'The plan of membership % allows % freeze%, and % used', m.membership_no, m.max_freezes, CASE WHEN m.max_freezes = 1 THEN '' ELSE 's' END,
      CASE WHEN taken = 1 THEN '1 is' ELSE taken || ' are' END USING ERRCODE = '23514';
  END IF;
  IF frozen + NEW.days > m.max_freeze_days THEN
    RAISE EXCEPTION 'The plan of membership % allows % days frozen in all: % left', m.membership_no, m.max_freeze_days, m.max_freeze_days - frozen USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_freezes_check BEFORE INSERT OR UPDATE OR DELETE ON member_freezes
  FOR EACH ROW EXECUTE FUNCTION member_freezes_check();

-- The membership's frozen days and last day follow its freezes.
CREATE FUNCTION member_freezes_extend() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE member_memberships m SET frozen_days = f.days, end_on = m.base_end_on + f.days, updated_at = now()
  FROM (SELECT COALESCE(sum(days), 0)::smallint AS days FROM member_freezes WHERE business_id = NEW.business_id AND membership_id = NEW.membership_id) f
  WHERE m.business_id = NEW.business_id AND m.id = NEW.membership_id;
  RETURN NULL;
END $$;
CREATE TRIGGER member_freezes_extend AFTER INSERT OR UPDATE ON member_freezes
  FOR EACH ROW EXECUTE FUNCTION member_freezes_extend();

-- --- Instalments ---------------------------------------------------------------------------------

-- A membership's fee in instalments: each amount with the day it falls due.
CREATE TABLE member_instalments (
  business_id BIGINT NOT NULL,
  membership_id BIGINT NOT NULL,
  seq SMALLINT NOT NULL CHECK (seq BETWEEN 1 AND 36),
  due_on DATE NOT NULL,
  amount NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (business_id, membership_id, seq),
  FOREIGN KEY (business_id, membership_id) REFERENCES member_memberships(business_id, id)
);
CREATE INDEX member_instalments_due ON member_instalments(business_id, due_on);
CREATE TRIGGER member_instalments_append_only BEFORE UPDATE OR DELETE ON member_instalments
  FOR EACH ROW EXECUTE FUNCTION member_append_only();

-- Instalments are written with their membership, two or more, in order of
-- their due days (each later than the one before), and add up to its bill.
CREATE FUNCTION member_instalments_check() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE CONSTRAINT TRIGGER member_instalments_check AFTER INSERT ON member_instalments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION member_instalments_check();

-- --- Check-ins -----------------------------------------------------------------------------------

-- Every check-in at the desk: found by searching or by the member's code,
-- let in on a membership or turned away with the reason.
CREATE TABLE member_checkins (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  -- The membership it let them in on (or turned them away on); none when the member holds none.
  membership_id BIGINT,
  -- The business's date of the check-in (set by the database).
  day DATE NOT NULL,
  found_by TEXT NOT NULL CHECK (found_by IN ('search', 'code')),
  allowed BOOLEAN NOT NULL,
  reason TEXT CHECK (reason IN ('no_membership', 'not_started', 'expired', 'frozen', 'no_sessions', 'dues')),
  note VARCHAR(300),
  -- A pack's session it used (one a day).
  session_used BOOLEAN NOT NULL DEFAULT FALSE,
  request_key UUID NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, membership_id) REFERENCES member_memberships(business_id, id),
  UNIQUE (business_id, request_key),
  CHECK (allowed = (reason IS NULL)),
  CHECK (NOT session_used OR allowed),
  CHECK (NOT allowed OR membership_id IS NOT NULL),
  CHECK ((reason = 'no_membership') = (membership_id IS NULL))
);
CREATE INDEX member_checkins_day ON member_checkins(business_id, day DESC, id DESC);
CREATE INDEX member_checkins_member ON member_checkins(business_id, contact_id, id DESC);
CREATE UNIQUE INDEX member_checkins_one_session_a_day ON member_checkins(business_id, membership_id, day) WHERE session_used;
CREATE TRIGGER member_checkins_customer BEFORE INSERT ON member_checkins
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();
CREATE TRIGGER member_checkins_append_only BEFORE UPDATE OR DELETE ON member_checkins
  FOR EACH ROW EXECUTE FUNCTION member_append_only();

-- A check-in is dated on the business's clock. One that lets a member in is
-- on their own membership while it runs that day: started, not closed, not
-- frozen, within its last day and grace days; a pack's session is used only
-- while one is left.
CREATE FUNCTION member_checkins_check() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER member_checkins_check BEFORE INSERT ON member_checkins
  FOR EACH ROW EXECUTE FUNCTION member_checkins_check();

-- A session used comes off the pack.
CREATE FUNCTION member_checkins_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.session_used THEN
    UPDATE member_memberships SET sessions_used = sessions_used + 1, updated_at = now() WHERE business_id = NEW.business_id AND id = NEW.membership_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER member_checkins_session AFTER INSERT ON member_checkins
  FOR EACH ROW EXECUTE FUNCTION member_checkins_session();

-- --- History and reminders -----------------------------------------------------------------------

-- Everything that happened to a membership: how it began (sold, a renewal,
-- an upgrade, a transfer in), freezes and their early ends, and how it was
-- closed, with the figures of each.
CREATE TABLE member_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  membership_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sold', 'renewal', 'upgrade', 'transfer', 'frozen', 'freeze_ended', 'transferred', 'upgraded', 'cancelled')),
  note VARCHAR(500),
  details JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, membership_id) REFERENCES member_memberships(business_id, id)
);
CREATE INDEX member_events_membership ON member_events(business_id, membership_id, id);
CREATE TRIGGER member_events_append_only BEFORE UPDATE OR DELETE ON member_events
  FOR EACH ROW EXECUTE FUNCTION member_append_only();

-- A reminder given to a member: their membership running out, or fees due; and how.
CREATE TABLE member_reminders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  membership_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('renewal', 'fees')),
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'call', 'sms')),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, membership_id) REFERENCES member_memberships(business_id, id)
);
CREATE INDEX member_reminders_membership ON member_reminders(business_id, membership_id, kind, created_at DESC);
CREATE TRIGGER member_reminders_append_only BEFORE UPDATE OR DELETE ON member_reminders
  FOR EACH ROW EXECUTE FUNCTION member_append_only();

-- Down Migration
DROP TRIGGER business_return_lines_member_plan ON business_return_lines;
DROP TABLE member_reminders, member_events, member_checkins, member_instalments, member_freezes, member_memberships, member_profiles;
ALTER TABLE member_plan_types DROP CONSTRAINT member_plan_types_policy_fkey;
DROP TABLE member_plan_policies, member_plan_types, member_settings;
DROP FUNCTION member_checkins_session();
DROP FUNCTION member_checkins_check();
DROP FUNCTION member_instalments_check();
DROP FUNCTION member_freezes_extend();
DROP FUNCTION member_freezes_check();
DROP FUNCTION member_plan_line_return();
DROP FUNCTION member_memberships_guard();
DROP FUNCTION member_memberships_insert_check();
DROP FUNCTION member_plan_types_check();
DROP FUNCTION member_append_only();
DELETE FROM business_number_series WHERE document_kind = 'membership';
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  kinds := array_remove(kinds, 'membership');
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;
DELETE FROM business_role_permissions WHERE role_id IN (SELECT id FROM business_roles WHERE template_code = 'trainer');
UPDATE business_memberships m SET role_id = (SELECT r2.id FROM business_roles r2 WHERE r2.business_id = m.business_id AND r2.template_code = 'viewer')
  WHERE role_id IN (SELECT id FROM business_roles WHERE template_code = 'trainer');
DELETE FROM business_roles WHERE template_code = 'trainer';
DELETE FROM business_role_template_permissions WHERE template_code = 'trainer';
DELETE FROM business_role_templates WHERE code = 'trainer';
DELETE FROM business_capabilities WHERE capability = 'member_plans';
DELETE FROM business_role_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'member_plans');
DELETE FROM business_role_template_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'member_plans');
DELETE FROM business_permissions WHERE module_code = 'member_plans';
DELETE FROM platform_module_business_types WHERE module_code = 'member_plans';
DELETE FROM platform_module_dependencies WHERE module_code = 'member_plans';
DELETE FROM platform_modules WHERE code = 'member_plans';
