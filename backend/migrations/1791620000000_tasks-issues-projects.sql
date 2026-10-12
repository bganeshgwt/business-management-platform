-- Up Migration
-- Tasks, issues & projects: the operations module every business type uses
-- (opening and closing checklists, FSSAI hygiene audits, temperature logs,
-- stock checks, maintenance, hiring, festival set-ups, new outlets).
--
-- ONE data model for every business, keyed on business_id. A restaurant
-- works here through its business row (businesses.legacy_restaurant_id,
-- restaurant_business_id()). The only restaurant-specific columns are where
-- (outlet_id; other types use location_id) and who (a restaurant employee or
-- restaurant role; other types use a business resource or business role).
-- A trigger checks those point inside the business's own restaurant, so a
-- cross-tenant pointer is refused by the database, as the composite keys do
-- for everything else.
--
-- Three optional modules, on by default for all twelve types: tasks, issues
-- (needs tasks), projects (needs tasks). Built-in templates live in code
-- (backend/src/modules/tasks/library); a business's own templates are rows.

-- --- Modules, permissions --------------------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order, feature_group) VALUES
 ('tasks', 'Tasks & checklists', 'Daily checklists, recurring tasks, a template library, My tasks for staff, the team board, calendar and compliance reports.', 'optional', 400, 'Operations'),
 ('issues', 'Issues', 'Report problems with a photo, assign and track them to closed. Failed checklist answers raise them by themselves.', 'optional', 401, 'Operations'),
 ('projects', 'Projects', 'Bigger jobs with members, milestones and task lists: a new outlet, a festival sale, the annual stock audit.', 'optional', 402, 'Operations');

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('issues', 'tasks'), ('projects', 'tasks');

INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default)
SELECT m.code, t.code, TRUE
FROM (VALUES ('tasks'), ('issues'), ('projects')) AS m(code)
CROSS JOIN business_types t;

-- assign, review and manage are new actions (a permission code is always
-- module.action). This CHECK lists values: any later change must keep the
-- whole list.
ALTER TABLE business_permissions DROP CONSTRAINT business_permissions_action_check,
  ADD CONSTRAINT business_permissions_action_check
  CHECK (action IN ('view', 'create', 'edit', 'approve', 'cancel', 'refund', 'export', 'print', 'discount', 'assign', 'review', 'manage'));

INSERT INTO business_permissions (code, module_code, action, name, sort_order) VALUES
 ('tasks.view', 'tasks', 'view', 'See everyone''s tasks, the board, calendar and task reports', 400),
 ('tasks.create', 'tasks', 'create', 'Create tasks and use templates', 401),
 ('tasks.assign', 'tasks', 'assign', 'Assign tasks to anyone, change others'' tasks and recurring tasks', 402),
 ('tasks.review', 'tasks', 'review', 'Approve or send back finished tasks that need a review', 403),
 ('tasks.manage', 'tasks', 'manage', 'Keep the template library, cancel and delete tasks', 404),
 ('issues.view', 'issues', 'view', 'See every issue', 410),
 ('issues.create', 'issues', 'create', 'Report an issue', 411),
 ('issues.assign', 'issues', 'assign', 'Assign issues and work on them', 412),
 ('issues.review', 'issues', 'review', 'Close and reopen issues', 413),
 ('issues.manage', 'issues', 'manage', 'Delete issues', 414),
 ('projects.view', 'projects', 'view', 'See every project', 420),
 ('projects.create', 'projects', 'create', 'Start a project', 421),
 ('projects.manage', 'projects', 'manage', 'Change any project, its members and milestones', 422);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code IN ('tasks', 'issues', 'projects')
UNION ALL SELECT 'cashier', 'issues.create'
UNION ALL SELECT 'stock_keeper', 'issues.create'
UNION ALL SELECT 'accountant', unnest(ARRAY['tasks.view', 'issues.view', 'projects.view'])
UNION ALL SELECT 'viewer', unnest(ARRAY['tasks.view', 'issues.view', 'projects.view']);

INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code IN ('tasks', 'issues', 'projects')
WHERE NOT r.full_access
ON CONFLICT DO NOTHING;

-- Every existing business: on (tasks first, the other two need it).
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, 'tasks' FROM businesses b ON CONFLICT DO NOTHING;
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, m.code FROM businesses b CROSS JOIN (VALUES ('issues'), ('projects')) AS m(code)
ON CONFLICT DO NOTHING;

-- The restaurant's own permission list (its role editor), the same codes.
INSERT INTO permissions (code, module, name, description) VALUES
 ('tasks.view', 'tasks', 'See everyone''s tasks', 'The team board, calendar and task reports. Without it a person sees only their own tasks.'),
 ('tasks.create', 'tasks', 'Create tasks', 'Create tasks and use templates. Without "assign" only for themselves.'),
 ('tasks.assign', 'tasks', 'Assign tasks', 'Assign to anyone, change others'' tasks and recurring tasks.'),
 ('tasks.review', 'tasks', 'Review finished tasks', 'Approve or send back tasks that need a review.'),
 ('tasks.manage', 'tasks', 'Manage templates and tasks', 'Keep the template library, cancel and delete tasks.'),
 ('issues.view', 'tasks', 'See every issue', NULL),
 ('issues.create', 'tasks', 'Report an issue', NULL),
 ('issues.assign', 'tasks', 'Assign and work on issues', NULL),
 ('issues.review', 'tasks', 'Close and reopen issues', NULL),
 ('issues.manage', 'tasks', 'Delete issues', NULL),
 ('projects.view', 'tasks', 'See every project', NULL),
 ('projects.create', 'tasks', 'Start a project', NULL),
 ('projects.manage', 'tasks', 'Change any project', NULL);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.module = 'tasks'
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE
  AND (r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER')
    OR (r.code IN ('CASHIER', 'CAPTAIN', 'KITCHEN', 'STORE_KEEPER') AND p.code = 'issues.create')
    OR (r.code = 'ACCOUNTANT' AND p.code IN ('tasks.view', 'issues.view', 'projects.view')))
ON CONFLICT DO NOTHING;

-- --- Categories -------------------------------------------------------------------

CREATE TABLE platform_task_categories (
  code        TEXT PRIMARY KEY CHECK (code ~ '^[a-z_]{2,40}$'),
  name        VARCHAR(80) NOT NULL,
  icon        VARCHAR(30) NOT NULL,
  sort_order  SMALLINT NOT NULL
);

INSERT INTO platform_task_categories (code, name, icon, sort_order) VALUES
 ('stock_check', 'Stock check', 'box', 10),
 ('audit', 'Audit', 'clipboard', 20),
 ('cleaning', 'Cleaning', 'sparkles', 30),
 ('day_to_day', 'Day to day task', 'list', 40),
 ('hiring', 'Hiring', 'users', 50),
 ('maintenance', 'Maintenance & repair work', 'settings', 60),
 ('marketing', 'Marketing', 'star', 70),
 ('opening_closing', 'Opening & closing', 'clock', 80),
 ('procurement', 'Order placement & procurement', 'truck', 90),
 ('production', 'Production', 'chef', 100),
 ('project_management', 'Project management', 'layers', 110),
 ('food_safety', 'Food safety & hygiene', 'shield', 120),
 ('health_safety', 'Health & safety', 'heart', 130),
 ('others', 'Others', 'more', 140);

-- --- Where and who belong to this business ------------------------------------------

-- outlet_id, employee_id and a restaurant role_id must belong to the
-- business's own restaurant; location_id is for the other types only; a user
-- named on a record must work in this business. Generic over every table of
-- the module (read through to_jsonb, so a table without a column skips it).
CREATE FUNCTION business_task_world_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rec JSONB := to_jsonb(NEW);
  restaurant BIGINT;
  person TEXT;
  col TEXT;
BEGIN
  SELECT legacy_restaurant_id INTO restaurant FROM businesses WHERE id = NEW.business_id;
  IF (rec->>'outlet_id') IS NOT NULL AND (restaurant IS NULL OR NOT EXISTS (
      SELECT 1 FROM outlets WHERE id = (rec->>'outlet_id')::bigint AND restaurant_id = restaurant)) THEN
    RAISE EXCEPTION 'That outlet is not part of this business' USING ERRCODE = '23514';
  END IF;
  IF (rec->>'location_id') IS NOT NULL AND restaurant IS NOT NULL THEN
    RAISE EXCEPTION 'A restaurant names an outlet, not a location' USING ERRCODE = '23514';
  END IF;
  IF (rec->>'employee_id') IS NOT NULL AND (restaurant IS NULL OR NOT EXISTS (
      SELECT 1 FROM employees WHERE id = (rec->>'employee_id')::bigint AND restaurant_id = restaurant)) THEN
    RAISE EXCEPTION 'That staff member is not part of this business' USING ERRCODE = '23514';
  END IF;
  IF (rec->>'role_id') IS NOT NULL AND (restaurant IS NULL OR NOT EXISTS (
      SELECT 1 FROM roles WHERE id = (rec->>'role_id')::bigint AND (restaurant_id = restaurant OR (restaurant_id IS NULL AND is_system)))) THEN
    RAISE EXCEPTION 'That role is not part of this business' USING ERRCODE = '23514';
  END IF;
  FOREACH col IN ARRAY ARRAY['user_id', 'assignee_user_id', 'owner_user_id'] LOOP
    person := rec->>col;
    IF person IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM business_memberships m WHERE m.business_id = NEW.business_id AND m.user_id = person::bigint)
      AND (restaurant IS NULL OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = person::bigint AND u.restaurant_id = restaurant)) THEN
      RAISE EXCEPTION 'That person does not work in this business' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

-- --- Templates ------------------------------------------------------------------------

CREATE TABLE business_task_templates (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id        BIGINT NOT NULL REFERENCES businesses(id),
  name               VARCHAR(120) NOT NULL CHECK (btrim(name) <> ''),
  description        VARCHAR(1000),
  category_code      TEXT NOT NULL REFERENCES platform_task_categories(code),
  priority           TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  requires_review    BOOLEAN NOT NULL DEFAULT FALSE,
  estimated_minutes  SMALLINT CHECK (estimated_minutes BETWEEN 1 AND 1440),
  -- The built-in template this one was copied from, if any.
  library_code       VARCHAR(80),
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_by         BIGINT REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         BIGINT REFERENCES users(id),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE INDEX business_task_templates_list ON business_task_templates (business_id, active, name);

-- The answer kinds a checklist item can take. Shared by template items and
-- task items (the task keeps its own copy, so editing a template never
-- changes a checklist already done).
CREATE TABLE business_task_template_items (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id     BIGINT NOT NULL,
  template_id     BIGINT NOT NULL,
  position        SMALLINT NOT NULL CHECK (position BETWEEN 0 AND 500),
  kind            TEXT NOT NULL CHECK (kind IN ('section', 'checkbox', 'yes_no', 'number', 'text', 'photo', 'signature', 'choice')),
  label           VARCHAR(200) NOT NULL CHECK (btrim(label) <> ''),
  help            VARCHAR(500),
  required        BOOLEAN NOT NULL DEFAULT TRUE,
  unit            VARCHAR(20),
  min_value       NUMERIC(12,3),
  max_value       NUMERIC(12,3),
  -- choice: [{"label": "Clean", "fail": false}, {"label": "Dirty", "fail": true}]
  options         JSONB,
  -- yes_no: the answer that passes.
  expected        TEXT CHECK (expected IN ('yes', 'no')),
  photo_required  BOOLEAN NOT NULL DEFAULT FALSE,
  -- A failed critical item fails the whole checklist, whatever its score.
  critical        BOOLEAN NOT NULL DEFAULT FALSE,
  raise_issue     BOOLEAN NOT NULL DEFAULT TRUE,
  fail_severity   TEXT NOT NULL DEFAULT 'medium' CHECK (fail_severity IN ('low', 'medium', 'high', 'critical')),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, template_id) REFERENCES business_task_templates(business_id, id) ON DELETE CASCADE,
  CONSTRAINT business_task_template_items_range CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value),
  CONSTRAINT business_task_template_items_choice CHECK (kind <> 'choice' OR jsonb_typeof(options) = 'array')
);
CREATE INDEX business_task_template_items_template ON business_task_template_items (business_id, template_id, position);

-- --- Projects (before tasks: tasks point at them) ------------------------------------------

CREATE TABLE business_projects (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id    BIGINT NOT NULL REFERENCES businesses(id),
  name           VARCHAR(120) NOT NULL CHECK (btrim(name) <> ''),
  description    VARCHAR(2000),
  owner_user_id  BIGINT NOT NULL REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('planning', 'active', 'on_hold', 'completed', 'cancelled')),
  start_on       DATE,
  end_on         DATE,
  location_id    BIGINT,
  outlet_id      BIGINT REFERENCES outlets(id),
  template_code  VARCHAR(80),
  completed_at   TIMESTAMPTZ,
  created_by     BIGINT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     BIGINT REFERENCES users(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  CONSTRAINT business_projects_dates CHECK (end_on IS NULL OR start_on IS NULL OR end_on >= start_on),
  CONSTRAINT business_projects_one_place CHECK (num_nonnulls(location_id, outlet_id) <= 1),
  CONSTRAINT business_projects_completed CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX business_projects_list ON business_projects (business_id, status, id DESC);

CREATE TABLE business_project_members (
  business_id  BIGINT NOT NULL,
  project_id   BIGINT NOT NULL,
  user_id      BIGINT NOT NULL REFERENCES users(id),
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, project_id, user_id),
  FOREIGN KEY (business_id, project_id) REFERENCES business_projects(business_id, id) ON DELETE CASCADE
);
CREATE INDEX business_project_members_user ON business_project_members (business_id, user_id);

CREATE TABLE business_project_milestones (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id  BIGINT NOT NULL,
  project_id   BIGINT NOT NULL,
  name         VARCHAR(120) NOT NULL CHECK (btrim(name) <> ''),
  due_on       DATE,
  position     SMALLINT NOT NULL DEFAULT 0,
  done_at      TIMESTAMPTZ,
  done_by      BIGINT REFERENCES users(id),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, project_id) REFERENCES business_projects(business_id, id) ON DELETE CASCADE,
  CONSTRAINT business_project_milestones_done CHECK ((done_at IS NULL) = (done_by IS NULL))
);

CREATE TABLE business_project_lists (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id  BIGINT NOT NULL,
  project_id   BIGINT NOT NULL,
  name         VARCHAR(80) NOT NULL CHECK (btrim(name) <> ''),
  position     SMALLINT NOT NULL DEFAULT 0,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, project_id) REFERENCES business_projects(business_id, id) ON DELETE CASCADE
);

-- --- Recurring tasks ---------------------------------------------------------------------

CREATE TABLE business_task_schedules (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id        BIGINT NOT NULL REFERENCES businesses(id),
  title              VARCHAR(160) NOT NULL CHECK (btrim(title) <> ''),
  description        VARCHAR(2000),
  template_id        BIGINT,
  library_code       VARCHAR(80),
  category_code      TEXT NOT NULL REFERENCES platform_task_categories(code),
  priority           TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  location_id        BIGINT,
  outlet_id          BIGINT REFERENCES outlets(id),
  assign_mode        TEXT NOT NULL CHECK (assign_mode IN ('people', 'role', 'on_shift', 'unassigned')),
  frequency          TEXT NOT NULL CHECK (frequency IN ('daily', 'weekdays', 'weekly', 'monthly', 'every_n_days', 'per_shift')),
  every_n            SMALLINT CHECK (every_n BETWEEN 1 AND 365),
  -- 0 = Sunday … 6 = Saturday (weekdays / weekly).
  weekdays           SMALLINT[] CHECK (weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
  month_day          SMALLINT CHECK (month_day BETWEEN 1 AND 31),
  -- One occurrence per time (temperature log at 10:00 and 16:00). Before
  -- 05:00 belongs to the trading day before (a 01:00 closing check).
  due_times          TIME[] NOT NULL DEFAULT ARRAY['18:00'::time],
  -- per_shift at a restaurant: only this shift (NULL = every active shift).
  shift_id           BIGINT REFERENCES shifts(id),
  -- The task opens this many minutes before it is due (NULL: at the start of the day).
  window_minutes     SMALLINT CHECK (window_minutes BETWEEN 5 AND 1440),
  starts_on          DATE NOT NULL,
  ends_on            DATE,
  requires_review    BOOLEAN NOT NULL DEFAULT FALSE,
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  -- Occurrences exist up to this day (generation is idempotent and lazy).
  generated_through  DATE,
  created_by         BIGINT REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         BIGINT REFERENCES users(id),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, template_id) REFERENCES business_task_templates(business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  CONSTRAINT business_task_schedules_dates CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT business_task_schedules_one_place CHECK (num_nonnulls(location_id, outlet_id) <= 1),
  CONSTRAINT business_task_schedules_one_template CHECK (num_nonnulls(template_id, library_code) <= 1),
  CONSTRAINT business_task_schedules_times CHECK (cardinality(due_times) BETWEEN 1 AND 12),
  CONSTRAINT business_task_schedules_shape CHECK (
    (frequency <> 'every_n_days' OR every_n IS NOT NULL)
    AND (frequency NOT IN ('weekly', 'weekdays') OR cardinality(weekdays) >= 1)
    AND (frequency <> 'monthly' OR month_day IS NOT NULL))
);
CREATE INDEX business_task_schedules_active ON business_task_schedules (business_id) WHERE active;

-- --- Issues (before tasks: a task may be made from an issue) ----------------------------------

CREATE TABLE business_issues (
  id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id              BIGINT NOT NULL REFERENCES businesses(id),
  number                   INTEGER NOT NULL CHECK (number > 0),
  title                    VARCHAR(200) NOT NULL CHECK (btrim(title) <> ''),
  description              VARCHAR(2000),
  category_code            TEXT NOT NULL REFERENCES platform_task_categories(code),
  severity                 TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status                   TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  location_id              BIGINT,
  outlet_id                BIGINT REFERENCES outlets(id),
  -- "Walk-in freezer", "Weighing scale 2", "Delivery van KA-01-1234": free text.
  asset_label              VARCHAR(120),
  assignee_user_id         BIGINT REFERENCES users(id),
  due_at                   TIMESTAMPTZ,
  reported_by              BIGINT NOT NULL REFERENCES users(id),
  reported_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at              TIMESTAMPTZ,
  resolved_by              BIGINT REFERENCES users(id),
  resolution_note          VARCHAR(1000),
  closed_at                TIMESTAMPTZ,
  closed_by                BIGINT REFERENCES users(id),
  source_task_id           BIGINT,
  source_task_item_id      BIGINT,
  source_logbook_entry_id  BIGINT REFERENCES logbook_entries(id) ON DELETE SET NULL,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, number),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  CONSTRAINT business_issues_one_place CHECK (num_nonnulls(location_id, outlet_id) <= 1),
  CONSTRAINT business_issues_resolved CHECK ((status IN ('resolved', 'closed')) = (resolved_at IS NOT NULL)),
  CONSTRAINT business_issues_closed CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX business_issues_list ON business_issues (business_id, status, id DESC);
CREATE INDEX business_issues_assignee ON business_issues (business_id, assignee_user_id) WHERE status IN ('open', 'in_progress');
CREATE UNIQUE INDEX business_issues_one_per_logbook_entry ON business_issues (source_logbook_entry_id) WHERE source_logbook_entry_id IS NOT NULL;

-- --- Tasks ----------------------------------------------------------------------------------

CREATE TABLE business_tasks (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id       BIGINT NOT NULL REFERENCES businesses(id),
  title             VARCHAR(160) NOT NULL CHECK (btrim(title) <> ''),
  description       VARCHAR(2000),
  category_code     TEXT NOT NULL REFERENCES platform_task_categories(code),
  priority          TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status            TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done', 'missed', 'cancelled')),
  location_id       BIGINT,
  outlet_id         BIGINT REFERENCES outlets(id),
  assign_mode       TEXT NOT NULL DEFAULT 'people' CHECK (assign_mode IN ('people', 'role', 'on_shift', 'unassigned')),
  opens_at          TIMESTAMPTZ,
  due_at            TIMESTAMPTZ,
  -- After this a task not done is missed (recurring: the end of its trading day).
  closes_at         TIMESTAMPTZ,
  schedule_id       BIGINT,
  occurrence_date   DATE,
  occurrence_slot   SMALLINT,
  shift_label       VARCHAR(100),
  template_id       BIGINT,
  library_code      VARCHAR(80),
  project_id        BIGINT,
  project_list_id   BIGINT,
  milestone_id      BIGINT,
  issue_id          BIGINT,
  requires_review   BOOLEAN NOT NULL DEFAULT FALSE,
  review_status     TEXT CHECK (review_status IN ('pending', 'approved', 'changes_requested')),
  reviewed_by       BIGINT REFERENCES users(id),
  reviewed_at       TIMESTAMPTZ,
  review_note       VARCHAR(500),
  started_at        TIMESTAMPTZ,
  started_by        BIGINT REFERENCES users(id),
  completed_at      TIMESTAMPTZ,
  completed_by      BIGINT REFERENCES users(id),
  cancelled_at      TIMESTAMPTZ,
  cancelled_by      BIGINT REFERENCES users(id),
  cancel_reason     VARCHAR(300),
  item_count        SMALLINT NOT NULL DEFAULT 0,
  answered_count    SMALLINT NOT NULL DEFAULT 0,
  failed_count      SMALLINT NOT NULL DEFAULT 0,
  score_percent     NUMERIC(5,2),
  critical_failed   BOOLEAN NOT NULL DEFAULT FALSE,
  created_by        BIGINT REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, schedule_id) REFERENCES business_task_schedules(business_id, id),
  FOREIGN KEY (business_id, template_id) REFERENCES business_task_templates(business_id, id),
  FOREIGN KEY (business_id, project_id) REFERENCES business_projects(business_id, id),
  FOREIGN KEY (business_id, project_list_id) REFERENCES business_project_lists(business_id, id) ON DELETE SET NULL (project_list_id),
  FOREIGN KEY (business_id, milestone_id) REFERENCES business_project_milestones(business_id, id) ON DELETE SET NULL (milestone_id),
  FOREIGN KEY (business_id, issue_id) REFERENCES business_issues(business_id, id),
  CONSTRAINT business_tasks_one_place CHECK (num_nonnulls(location_id, outlet_id) <= 1),
  CONSTRAINT business_tasks_occurrence CHECK ((schedule_id IS NULL) = (occurrence_date IS NULL) AND (schedule_id IS NULL) = (occurrence_slot IS NULL)),
  CONSTRAINT business_tasks_done CHECK ((status = 'done') = (completed_at IS NOT NULL)),
  CONSTRAINT business_tasks_cancelled CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT business_tasks_review CHECK (review_status IS NULL OR requires_review),
  CONSTRAINT business_tasks_window CHECK (due_at IS NULL OR opens_at IS NULL OR opens_at <= due_at),
  CONSTRAINT business_tasks_list_needs_project CHECK ((project_list_id IS NULL AND milestone_id IS NULL) OR project_id IS NOT NULL)
);
-- A recurring occurrence exists once, however many screens ask at the same time.
CREATE UNIQUE INDEX business_tasks_occurrence_once ON business_tasks (business_id, schedule_id, occurrence_date, occurrence_slot)
  WHERE schedule_id IS NOT NULL;
CREATE INDEX business_tasks_due ON business_tasks (business_id, due_at);
CREATE INDEX business_tasks_open ON business_tasks (business_id, closes_at) WHERE status IN ('todo', 'in_progress');
CREATE INDEX business_tasks_project ON business_tasks (business_id, project_id) WHERE project_id IS NOT NULL;

ALTER TABLE business_issues
  ADD FOREIGN KEY (business_id, source_task_id) REFERENCES business_tasks(business_id, id);

CREATE TABLE business_task_assignees (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id       BIGINT NOT NULL,
  task_id           BIGINT,
  schedule_id       BIGINT,
  kind              TEXT NOT NULL CHECK (kind IN ('user', 'employee', 'resource', 'role', 'business_role')),
  user_id           BIGINT REFERENCES users(id),
  employee_id       BIGINT REFERENCES employees(id),
  resource_id       BIGINT,
  role_id           BIGINT REFERENCES roles(id),
  business_role_id  BIGINT,
  FOREIGN KEY (business_id, task_id) REFERENCES business_tasks(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, schedule_id) REFERENCES business_task_schedules(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, resource_id) REFERENCES business_resources(business_id, id),
  FOREIGN KEY (business_id, business_role_id) REFERENCES business_roles(business_id, id),
  CONSTRAINT business_task_assignees_owner CHECK (num_nonnulls(task_id, schedule_id) = 1),
  CONSTRAINT business_task_assignees_one CHECK (num_nonnulls(user_id, employee_id, resource_id, role_id, business_role_id) = 1),
  CONSTRAINT business_task_assignees_kind CHECK (
    (kind = 'user') = (user_id IS NOT NULL) AND (kind = 'employee') = (employee_id IS NOT NULL)
    AND (kind = 'resource') = (resource_id IS NOT NULL) AND (kind = 'role') = (role_id IS NOT NULL)
    AND (kind = 'business_role') = (business_role_id IS NOT NULL))
);
CREATE UNIQUE INDEX business_task_assignees_once ON business_task_assignees
  (business_id, COALESCE(task_id, 0), COALESCE(schedule_id, 0), kind, COALESCE(user_id, employee_id, resource_id, role_id, business_role_id));
CREATE INDEX business_task_assignees_task ON business_task_assignees (business_id, task_id);
CREATE INDEX business_task_assignees_user ON business_task_assignees (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE business_task_items (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id     BIGINT NOT NULL,
  task_id         BIGINT NOT NULL,
  position        SMALLINT NOT NULL CHECK (position BETWEEN 0 AND 500),
  kind            TEXT NOT NULL CHECK (kind IN ('section', 'checkbox', 'yes_no', 'number', 'text', 'photo', 'signature', 'choice')),
  label           VARCHAR(200) NOT NULL,
  help            VARCHAR(500),
  required        BOOLEAN NOT NULL DEFAULT TRUE,
  unit            VARCHAR(20),
  min_value       NUMERIC(12,3),
  max_value       NUMERIC(12,3),
  options         JSONB,
  expected        TEXT CHECK (expected IN ('yes', 'no')),
  photo_required  BOOLEAN NOT NULL DEFAULT FALSE,
  critical        BOOLEAN NOT NULL DEFAULT FALSE,
  raise_issue     BOOLEAN NOT NULL DEFAULT TRUE,
  fail_severity   TEXT NOT NULL DEFAULT 'medium' CHECK (fail_severity IN ('low', 'medium', 'high', 'critical')),
  -- The answer.
  value_bool      BOOLEAN,
  value_number    NUMERIC(12,3),
  value_text      VARCHAR(1000),
  value_choice    VARCHAR(120),
  note            VARCHAR(500),
  answered        BOOLEAN NOT NULL DEFAULT FALSE,
  failed          BOOLEAN NOT NULL DEFAULT FALSE,
  answered_by     BIGINT REFERENCES users(id),
  answered_at     TIMESTAMPTZ,
  issue_id        BIGINT,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, task_id) REFERENCES business_tasks(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, issue_id) REFERENCES business_issues(business_id, id) ON DELETE SET NULL (issue_id),
  CONSTRAINT business_task_items_answer CHECK (answered = (answered_at IS NOT NULL)),
  CONSTRAINT business_task_items_fail CHECK (NOT failed OR answered),
  CONSTRAINT business_task_items_range CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value)
);
CREATE INDEX business_task_items_task ON business_task_items (business_id, task_id, position);

ALTER TABLE business_issues
  ADD FOREIGN KEY (business_id, source_task_item_id) REFERENCES business_task_items(business_id, id) ON DELETE SET NULL (source_task_item_id);

-- --- Comments, files, the trail ---------------------------------------------------------

CREATE TABLE business_task_comments (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id  BIGINT NOT NULL,
  task_id      BIGINT,
  issue_id     BIGINT,
  project_id   BIGINT,
  body         VARCHAR(2000) NOT NULL CHECK (btrim(body) <> ''),
  created_by   BIGINT NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, task_id) REFERENCES business_tasks(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, issue_id) REFERENCES business_issues(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, project_id) REFERENCES business_projects(business_id, id) ON DELETE CASCADE,
  CONSTRAINT business_task_comments_owner CHECK (num_nonnulls(task_id, issue_id, project_id) = 1)
);
CREATE INDEX business_task_comments_task ON business_task_comments (business_id, task_id) WHERE task_id IS NOT NULL;
CREATE INDEX business_task_comments_issue ON business_task_comments (business_id, issue_id) WHERE issue_id IS NOT NULL;
CREATE INDEX business_task_comments_project ON business_task_comments (business_id, project_id) WHERE project_id IS NOT NULL;

-- Photos, signatures and files, kept in private_uploads/tasks/<business>/ and
-- only ever sent through the API.
CREATE TABLE business_task_files (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id   BIGINT NOT NULL,
  task_id       BIGINT,
  item_id       BIGINT,
  issue_id      BIGINT,
  project_id    BIGINT,
  kind          TEXT NOT NULL CHECK (kind IN ('photo', 'signature', 'file')),
  stored_name   VARCHAR(80) NOT NULL UNIQUE CHECK (stored_name ~ '^[a-f0-9]{32}\.(jpg|png|webp|pdf)$'),
  file_name     VARCHAR(160) NOT NULL,
  mime_type     VARCHAR(40) NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes    INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  uploaded_by   BIGINT NOT NULL REFERENCES users(id),
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at    TIMESTAMPTZ,
  removed_by    BIGINT REFERENCES users(id),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, task_id) REFERENCES business_tasks(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, item_id) REFERENCES business_task_items(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, issue_id) REFERENCES business_issues(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, project_id) REFERENCES business_projects(business_id, id) ON DELETE CASCADE,
  CONSTRAINT business_task_files_owner CHECK (num_nonnulls(task_id, issue_id, project_id) = 1),
  CONSTRAINT business_task_files_item CHECK (item_id IS NULL OR task_id IS NOT NULL),
  CONSTRAINT business_task_files_removed CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE INDEX business_task_files_task ON business_task_files (business_id, task_id) WHERE task_id IS NOT NULL;
CREATE INDEX business_task_files_issue ON business_task_files (business_id, issue_id) WHERE issue_id IS NOT NULL;

-- The history trail on every task, issue and project (append-only).
CREATE TABLE business_task_history (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id  BIGINT NOT NULL,
  task_id      BIGINT,
  issue_id     BIGINT,
  project_id   BIGINT,
  action       VARCHAR(40) NOT NULL,
  details      JSONB NOT NULL DEFAULT '{}',
  actor_id     BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, task_id) REFERENCES business_tasks(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, issue_id) REFERENCES business_issues(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, project_id) REFERENCES business_projects(business_id, id) ON DELETE CASCADE,
  CONSTRAINT business_task_history_owner CHECK (num_nonnulls(task_id, issue_id, project_id) = 1)
);
CREATE INDEX business_task_history_task ON business_task_history (business_id, task_id) WHERE task_id IS NOT NULL;
CREATE INDEX business_task_history_issue ON business_task_history (business_id, issue_id) WHERE issue_id IS NOT NULL;
CREATE INDEX business_task_history_project ON business_task_history (business_id, project_id) WHERE project_id IS NOT NULL;

CREATE FUNCTION business_task_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The history trail cannot be changed' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER business_task_history_no_update BEFORE UPDATE ON business_task_history
  FOR EACH ROW EXECUTE FUNCTION business_task_history_append_only();

-- Where and who: on every table that names an outlet, location, person or role.
CREATE TRIGGER business_tasks_world BEFORE INSERT OR UPDATE OF outlet_id, location_id ON business_tasks
  FOR EACH ROW EXECUTE FUNCTION business_task_world_check();
CREATE TRIGGER business_task_schedules_world BEFORE INSERT OR UPDATE OF outlet_id, location_id ON business_task_schedules
  FOR EACH ROW EXECUTE FUNCTION business_task_world_check();
CREATE TRIGGER business_issues_world BEFORE INSERT OR UPDATE OF outlet_id, location_id, assignee_user_id ON business_issues
  FOR EACH ROW EXECUTE FUNCTION business_task_world_check();
CREATE TRIGGER business_projects_world BEFORE INSERT OR UPDATE OF outlet_id, location_id, owner_user_id ON business_projects
  FOR EACH ROW EXECUTE FUNCTION business_task_world_check();
CREATE TRIGGER business_project_members_world BEFORE INSERT OR UPDATE ON business_project_members
  FOR EACH ROW EXECUTE FUNCTION business_task_world_check();
CREATE TRIGGER business_task_assignees_world BEFORE INSERT OR UPDATE ON business_task_assignees
  FOR EACH ROW EXECUTE FUNCTION business_task_world_check();

-- Down Migration
DROP TABLE business_task_history, business_task_files, business_task_comments;
ALTER TABLE business_issues DROP COLUMN source_task_item_id, DROP COLUMN source_task_id;
DROP TABLE business_task_items, business_task_assignees, business_tasks, business_issues, business_task_schedules,
  business_project_lists, business_project_milestones, business_project_members, business_projects,
  business_task_template_items, business_task_templates, platform_task_categories;
DROP FUNCTION business_task_history_append_only();
DROP FUNCTION business_task_world_check();
DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE module = 'tasks');
DELETE FROM permissions WHERE module = 'tasks';
DELETE FROM business_capabilities WHERE capability IN ('issues', 'projects');
DELETE FROM business_capabilities WHERE capability = 'tasks';
DELETE FROM business_role_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code IN ('tasks', 'issues', 'projects'));
DELETE FROM business_role_template_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code IN ('tasks', 'issues', 'projects'));
DELETE FROM business_permissions WHERE module_code IN ('tasks', 'issues', 'projects');
ALTER TABLE business_permissions DROP CONSTRAINT business_permissions_action_check,
  ADD CONSTRAINT business_permissions_action_check
  CHECK (action IN ('view', 'create', 'edit', 'approve', 'cancel', 'refund', 'export', 'print', 'discount'));
DELETE FROM platform_module_business_types WHERE module_code IN ('tasks', 'issues', 'projects');
DELETE FROM platform_module_dependencies WHERE module_code IN ('issues', 'projects');
DELETE FROM platform_modules WHERE code IN ('tasks', 'issues', 'projects');
