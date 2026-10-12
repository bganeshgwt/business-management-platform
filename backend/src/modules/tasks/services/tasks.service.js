const repo = require("../repositories/tasks.repository");
const templates = require("./templates.service");
const people = require("./people.service");
const recurrence = require("./recurrence.service");
const issues = require("./issues.service");
const { fail, id, optionalId, v, category, momentText, dateText, localToday, addDays, page, search, PRIORITIES, TASK_STATUSES } = require("./common");

// Tasks: one-off or a recurring occurrence, with or without a checklist.
//
//   todo → in_progress → done          (needs review: done + review pending →
//                                        approved, or sent back to in_progress)
//   todo / in_progress → missed         its window closed (recurring) — set by the sweep
//   todo / in_progress → cancelled
// "Overdue" is not stored: a task still open after its due time shows red.

const taskColumns = (scope, p) => `t.id, t.title, t.description, t.category_code AS category, t.priority, t.status, t.assign_mode,
  t.outlet_id, t.location_id, ${people.placeNameSql("t")} AS place_name,
  t.opens_at, t.due_at, t.closes_at, t.occurrence_date::text AS occurrence_date, t.shift_label, t.schedule_id, t.template_id, t.library_code,
  t.project_id, (SELECT name FROM business_projects pr WHERE pr.business_id = t.business_id AND pr.id = t.project_id) AS project_name,
  t.project_list_id, t.milestone_id, t.issue_id,
  t.requires_review, t.review_status, t.review_note, t.reviewed_at, (SELECT name FROM users WHERE id = t.reviewed_by) AS reviewed_by_name,
  t.started_at, (SELECT name FROM users WHERE id = t.started_by) AS started_by_name, t.started_by,
  t.completed_at, (SELECT name FROM users WHERE id = t.completed_by) AS completed_by_name,
  t.cancelled_at, t.cancel_reason, t.item_count, t.answered_count, t.failed_count, t.score_percent, t.critical_failed,
  t.created_at, t.created_by, (SELECT name FROM users WHERE id = t.created_by) AS created_by_name,
  ${people.assigneeNamesSql("t")} AS assignee_names,
  ${people.mineSql(scope, p, "t")} AS mine`;

const shape = (r) => ({
  id: Number(r.id), title: r.title, description: r.description, category: r.category, priority: r.priority, status: r.status,
  overdue: ["todo", "in_progress"].includes(r.status) && r.due_at && new Date(r.due_at) < new Date(),
  assignMode: r.assign_mode, assigneeNames: r.assignee_names, mine: Boolean(r.mine),
  placeId: Number(r.outlet_id || r.location_id) || null, placeName: r.place_name || null,
  opensAt: r.opens_at, dueAt: r.due_at, closesAt: r.closes_at, occurrenceDate: r.occurrence_date, shiftLabel: r.shift_label,
  scheduleId: r.schedule_id ? Number(r.schedule_id) : null, templateId: r.template_id ? Number(r.template_id) : null, libraryCode: r.library_code,
  projectId: r.project_id ? Number(r.project_id) : null, projectName: r.project_name || null,
  projectListId: r.project_list_id ? Number(r.project_list_id) : null, milestoneId: r.milestone_id ? Number(r.milestone_id) : null,
  issueId: r.issue_id ? Number(r.issue_id) : null,
  requiresReview: r.requires_review, reviewStatus: r.review_status, reviewNote: r.review_note, reviewedAt: r.reviewed_at, reviewedByName: r.reviewed_by_name || null,
  startedAt: r.started_at, startedByName: r.started_by_name || null, completedAt: r.completed_at, completedByName: r.completed_by_name || null,
  onTime: r.completed_at && r.due_at ? new Date(r.completed_at) <= new Date(r.due_at) : null,
  cancelledAt: r.cancelled_at, cancelReason: r.cancel_reason,
  itemCount: Number(r.item_count), answeredCount: Number(r.answered_count), failedCount: Number(r.failed_count),
  scorePercent: r.score_percent === null || r.score_percent === undefined ? null : Number(r.score_percent), criticalFailed: Boolean(r.critical_failed),
  createdAt: r.created_at, createdByName: r.created_by_name || null,
});

// --- Lists --------------------------------------------------------------------------

const SORTS = { due: "t.due_at NULLS LAST, t.id", "-due": "t.due_at DESC NULLS LAST, t.id DESC", priority: "array_position(ARRAY['urgent','high','normal','low'], t.priority), t.due_at NULLS LAST",
  title: "t.title, t.id", status: "array_position(ARRAY['in_progress','todo','done','missed','cancelled'], t.status), t.due_at NULLS LAST", created: "t.id DESC" };

// The team board / list: filters, search, paging. Everyone sees what they may.
async function list(scope, query = {}) {
  await recurrence.ensure(scope);
  const { limit, offset } = page(query);
  const p = new repo.Params([scope.businessId]);
  const where = ["t.business_id = $1", people.visibleSql(scope, p, "t")];
  const statuses = v.enumList(query.status, "Status", [...TASK_STATUSES, "open", "overdue", "review"]);
  if (statuses) {
    const parts = [];
    const plain = statuses.filter((s) => TASK_STATUSES.includes(s));
    if (plain.length) parts.push(`t.status = ANY(${p.add(plain)}::text[])`);
    if (statuses.includes("open")) parts.push("t.status IN ('todo', 'in_progress')");
    if (statuses.includes("overdue")) parts.push("(t.status IN ('todo', 'in_progress') AND t.due_at < now())");
    if (statuses.includes("review")) parts.push("(t.status = 'done' AND t.review_status = 'pending')");
    where.push(`(${parts.join(" OR ")})`);
  }
  if (query.category) where.push(`t.category_code = ${p.add(category(query.category))}`);
  if (query.priority) where.push(`t.priority = ${p.add(v.requiredEnum(query.priority, "Priority", PRIORITIES))}`);
  if (query.place) {
    const place = id(query.place, "Place");
    where.push(scope.world === "restaurant" ? `t.outlet_id = ${p.add(place)}` : `t.location_id = ${p.add(place)}`);
  }
  if (query.project) where.push(`t.project_id = ${p.add(id(query.project, "Project"))}`);
  if (query.schedule) where.push(`t.schedule_id = ${p.add(id(query.schedule, "Recurring task"))}`);
  if (query.kind === "recurring") where.push("t.schedule_id IS NOT NULL");
  if (query.kind === "one_off") where.push("t.schedule_id IS NULL");
  if (query.assignee) {
    const [kind, raw] = String(query.assignee).split(":");
    if (kind === "me") where.push(people.mineSql(scope, p, "t"));
    else if (kind === "on_shift") where.push("t.assign_mode = 'on_shift'");
    else if (kind === "unassigned") where.push("t.assign_mode = 'unassigned'");
    else {
      const column = { user: "user_id", employee: "employee_id", resource: "resource_id", role: "role_id", business_role: "business_role_id" }[kind];
      if (!column) fail(400, "Unknown assignee filter");
      where.push(`EXISTS (SELECT 1 FROM business_task_assignees a WHERE a.business_id = t.business_id AND a.task_id = t.id AND a.${column} = ${p.add(id(raw, "Assignee"))})`);
    }
  }
  const from = dateText(query.from, "From"), to = dateText(query.to, "To");
  if (from || to) {
    const tz = p.add(scope.timezone);
    if (from) where.push(`(COALESCE(t.due_at, t.created_at) AT TIME ZONE ${tz})::date >= ${p.add(from)}`);
    if (to) where.push(`(COALESCE(t.due_at, t.created_at) AT TIME ZONE ${tz})::date <= ${p.add(to)}`);
  }
  // Recurring occurrences days ahead clutter the board: by default up to tomorrow.
  if (!to && query.ahead !== "all") where.push(`(t.schedule_id IS NULL OR t.occurrence_date <= ${p.add(addDays(localToday(scope.timezone), 1))})`);
  const q = search(query.q);
  if (q) where.push(`(t.title ILIKE '%' || ${p.add(q)}::text || '%' OR t.description ILIKE '%' || ${p.add(q)}::text || '%')`);
  const order = SORTS[query.sort] || SORTS.status;
  const sql = `SELECT ${taskColumns(scope, p)}, count(*) OVER () AS total FROM business_tasks t WHERE ${where.join(" AND ")}
    ORDER BY ${order} LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`;
  const rows = await repo.all(repo.pool, sql, p.values);
  return { rows: rows.map(shape), total: rows.length ? Number(rows[0].total) : 0, limit, offset };
}

// My tasks: today (open now or due today), overdue, upcoming (next 7 days), done (today).
async function mine(scope, query = {}) {
  await recurrence.ensure(scope);
  const today = localToday(scope.timezone);
  const p = new repo.Params([scope.businessId]);
  const tz = p.add(scope.timezone);
  const day = `(COALESCE(t.due_at, t.created_at) AT TIME ZONE ${tz})::date`;
  const todayP = p.add(today);
  const outlet = scope.outletScope ? `AND (t.outlet_id IS NULL OR t.outlet_id = ${p.add(scope.outletScope)})` : "";
  const rows = await repo.all(repo.pool, `SELECT ${taskColumns(scope, p)},
      CASE
        WHEN t.status IN ('done', 'missed', 'cancelled') THEN 'done'
        WHEN t.due_at < now() THEN 'overdue'
        WHEN t.due_at IS NULL OR ${day} <= ${todayP}::date OR t.opens_at <= now() THEN 'today'
        ELSE 'upcoming' END AS bucket
    FROM business_tasks t
    WHERE t.business_id = $1 ${outlet} AND ${people.mineSql(scope, p, "t")}
      AND (
        (t.status IN ('todo', 'in_progress') AND (t.due_at IS NULL OR ${day} <= ${todayP}::date + 7))
        OR (t.status IN ('done', 'missed') AND COALESCE(t.completed_at, t.closes_at, t.updated_at) >= (${todayP}::date::timestamp AT TIME ZONE ${tz}))
        OR (t.status = 'in_progress' AND t.review_status = 'changes_requested'))
    ORDER BY t.due_at NULLS LAST, array_position(ARRAY['urgent','high','normal','low'], t.priority), t.id
    LIMIT 300`, p.values);
  const tasks = rows.map((r) => ({ ...shape(r), bucket: r.bucket }));
  const reviewCount = scope.can("tasks.review")
    ? Number((await repo.one(repo.pool, `SELECT count(*) AS n FROM business_tasks t WHERE t.business_id = $1 AND t.status = 'done' AND t.review_status = 'pending'
        ${scope.outletScope ? "AND (t.outlet_id IS NULL OR t.outlet_id = $2)" : ""}`, scope.outletScope ? [scope.businessId, scope.outletScope] : [scope.businessId])).n)
    : 0;
  return { today, tasks, reviewCount };
}

// The calendar: everything due between two days (tasks.view: everyone's; else your own).
async function calendar(scope, query = {}) {
  await recurrence.ensure(scope);
  const from = dateText(query.from, "From") || localToday(scope.timezone).slice(0, 8) + "01";
  const to = dateText(query.to, "To") || addDays(from, 41);
  if (to < from || (Date.parse(to) - Date.parse(from)) / 86400000 > 62) fail(400, "Choose up to two months");
  const p = new repo.Params([scope.businessId]);
  const tz = p.add(scope.timezone);
  const mineOnly = query.mine === "1" || !scope.can("tasks.view");
  const where = [`t.business_id = $1`, mineOnly ? `(${people.mineSql(scope, p, "t")})` : people.visibleSql(scope, p, "t"),
    `(COALESCE(t.due_at, t.created_at) AT TIME ZONE ${tz})::date BETWEEN ${p.add(from)} AND ${p.add(to)}`, "t.status <> 'cancelled'"];
  if (query.category) where.push(`t.category_code = ${p.add(category(query.category))}`);
  if (query.place) where.push(scope.world === "restaurant" ? `t.outlet_id = ${p.add(id(query.place, "Place"))}` : `t.location_id = ${p.add(id(query.place, "Place"))}`);
  const rows = await repo.all(repo.pool, `SELECT ${taskColumns(scope, p)}, (COALESCE(t.due_at, t.created_at) AT TIME ZONE ${tz})::date::text AS day
    FROM business_tasks t WHERE ${where.join(" AND ")} ORDER BY t.due_at NULLS LAST, t.id LIMIT 3000`, p.values);
  return { from, to, mineOnly, tasks: rows.map((r) => ({ ...shape(r), day: r.day })) };
}

// --- One task -------------------------------------------------------------------------

async function load(db, scope, taskId, { lock = false } = {}) {
  const p = new repo.Params([scope.businessId, id(taskId, "Task")]);
  const visible = people.visibleSql(scope, p, "t");
  const row = await repo.one(db, `SELECT ${taskColumns(scope, p)}, t.business_id, (${visible}) AS visible FROM business_tasks t WHERE t.business_id = $1 AND t.id = $2 ${lock ? "FOR UPDATE OF t" : ""}`, p.values);
  if (!row || !row.visible) fail(404, "Task not found");
  return row;
}

// What this person may do with this task.
function rights(scope, row) {
  const own = Number(row.created_by) === scope.userId;
  const open = ["todo", "in_progress"].includes(row.status);
  return {
    work: open && (Boolean(row.mine) || scope.can("tasks.assign")),
    edit: open && (scope.can("tasks.assign") || (own && scope.can("tasks.create"))),
    review: row.status === "done" && row.review_status === "pending" && scope.can("tasks.review"),
    cancel: open && (scope.can("tasks.manage") || (own && scope.can("tasks.create"))),
    reopen: ["done", "missed", "cancelled"].includes(row.status) && scope.can("tasks.manage"),
    comment: true,
  };
}

async function detail(scope, taskId) {
  const row = await load(repo.pool, scope, taskId);
  const [items, assignees, files, comments, history] = await Promise.all([
    repo.all(repo.pool, `SELECT i.*, (SELECT name FROM users WHERE id = i.answered_by) AS answered_by_name,
        (SELECT number FROM business_issues x WHERE x.business_id = i.business_id AND x.id = i.issue_id) AS issue_number
      FROM business_task_items i WHERE i.business_id = $1 AND i.task_id = $2 ORDER BY i.position`, [scope.businessId, row.id]),
    repo.all(repo.pool, `SELECT a.kind, COALESCE(a.user_id, a.employee_id, a.resource_id, a.role_id, a.business_role_id) AS id,
        COALESCE(u.name, e.name, r.name, ro.name, br.name) AS name
      FROM business_task_assignees a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN employees e ON e.id = a.employee_id
      LEFT JOIN business_resources r ON r.business_id = a.business_id AND r.id = a.resource_id LEFT JOIN roles ro ON ro.id = a.role_id
      LEFT JOIN business_roles br ON br.business_id = a.business_id AND br.id = a.business_role_id
      WHERE a.business_id = $1 AND a.task_id = $2 ORDER BY a.id`, [scope.businessId, row.id]),
    filesOf(repo.pool, scope, { taskId: row.id }),
    commentsOf(repo.pool, scope, { taskId: row.id }),
    historyOf(repo.pool, scope, { taskId: row.id }),
  ]);
  return {
    ...shape(row),
    assignees: assignees.map((a) => ({ kind: a.kind, id: Number(a.id), name: a.name })),
    items: items.map((i) => ({
      ...templates.shapeItem(i), id: Number(i.id),
      answered: i.answered, failed: i.failed, note: i.note,
      value: i.kind === "checkbox" ? i.value_bool : i.kind === "yes_no" ? (i.value_bool === null ? null : i.value_bool ? "yes" : "no")
        : i.kind === "number" ? (i.value_number === null ? null : Number(i.value_number)) : i.kind === "text" ? i.value_text : i.kind === "choice" ? i.value_choice : null,
      answeredAt: i.answered_at, answeredByName: i.answered_by_name || null,
      issueId: i.issue_id ? Number(i.issue_id) : null, issueNumber: i.issue_number ? Number(i.issue_number) : null,
    })),
    files, comments, history,
    can: rights(scope, row),
  };
}

const filesOf = async (db, scope, owner) => {
  const [column, value] = Object.entries({ task_id: owner.taskId, issue_id: owner.issueId, project_id: owner.projectId }).find(([, x]) => x);
  const rows = await repo.all(db, `SELECT f.id, f.item_id, f.kind, f.file_name, f.mime_type, f.size_bytes, f.uploaded_at, f.uploaded_by, u.name AS uploaded_by_name
    FROM business_task_files f JOIN users u ON u.id = f.uploaded_by WHERE f.business_id = $1 AND f.${column} = $2 AND f.removed_at IS NULL ORDER BY f.id`,
  [scope.businessId, value]);
  return rows.map((f) => ({ id: Number(f.id), itemId: f.item_id ? Number(f.item_id) : null, kind: f.kind, fileName: f.file_name, mimeType: f.mime_type,
    sizeBytes: Number(f.size_bytes), uploadedAt: f.uploaded_at, uploadedByName: f.uploaded_by_name, mine: Number(f.uploaded_by) === scope.userId }));
};
const commentsOf = async (db, scope, owner) => {
  const [column, value] = Object.entries({ task_id: owner.taskId, issue_id: owner.issueId, project_id: owner.projectId }).find(([, x]) => x);
  const rows = await repo.all(db, `SELECT c.id, c.body, c.created_at, c.created_by, u.name AS author FROM business_task_comments c JOIN users u ON u.id = c.created_by
    WHERE c.business_id = $1 AND c.${column} = $2 ORDER BY c.id`, [scope.businessId, value]);
  return rows.map((c) => ({ id: Number(c.id), body: c.body, createdAt: c.created_at, author: c.author, mine: Number(c.created_by) === scope.userId }));
};
const historyOf = async (db, scope, owner) => {
  const [column, value] = Object.entries({ task_id: owner.taskId, issue_id: owner.issueId, project_id: owner.projectId }).find(([, x]) => x);
  const rows = await repo.all(db, `SELECT h.id, h.action, h.details, h.created_at, u.name AS actor FROM business_task_history h LEFT JOIN users u ON u.id = h.actor_id
    WHERE h.business_id = $1 AND h.${column} = $2 ORDER BY h.id DESC LIMIT 200`, [scope.businessId, value]);
  return rows.map((h) => ({ id: Number(h.id), action: h.action, details: h.details, at: h.created_at, actor: h.actor || "System" }));
};

// --- Create and change ------------------------------------------------------------------

async function readProjectLink(db, scope, body) {
  const projectId = optionalId(body.projectId, "Project");
  if (!projectId) return { projectId: null, listId: null, milestoneId: null };
  await scope.requireModule("projects");
  const project = await repo.one(db, `SELECT p.id, p.status, EXISTS (SELECT 1 FROM business_project_members m WHERE m.business_id = p.business_id AND m.project_id = p.id AND m.user_id = $3) AS member
    FROM business_projects p WHERE p.business_id = $1 AND p.id = $2`, [scope.businessId, projectId, scope.userId]);
  if (!project) fail(400, "Project not found");
  if (!project.member && !scope.can("projects.manage")) fail(403, "Only the project's members can add tasks to it");
  const listId = optionalId(body.projectListId ?? body.listId, "Task list");
  const milestoneId = optionalId(body.milestoneId, "Milestone");
  if (listId && !(await repo.one(db, "SELECT 1 FROM business_project_lists WHERE business_id = $1 AND project_id = $2 AND id = $3", [scope.businessId, projectId, listId]))) fail(400, "Task list not found");
  if (milestoneId && !(await repo.one(db, "SELECT 1 FROM business_project_milestones WHERE business_id = $1 AND project_id = $2 AND id = $3", [scope.businessId, projectId, milestoneId]))) fail(400, "Milestone not found");
  return { projectId, listId, milestoneId };
}

// Create a task in an open transaction (projects and issues call this too).
async function createIn(db, scope, body, { fromIssue = null } = {}) {
  const source = await templates.resolve(db, scope, { templateId: optionalId(body.templateId, "Template"), libraryCode: body.libraryCode || null });
  const title = v.optionalString(body.title, "Title", 160) || source?.name;
  if (!title) fail(400, "Title is required");
  const description = body.description === undefined ? source?.description || null : v.optionalString(body.description, "Description", 2000);
  const cat = category(body.category, source?.category || "day_to_day");
  const priority = v.optionalEnum(body.priority, "Priority", PRIORITIES, source?.priority || "normal");
  const dueAt = momentText(body.dueAt, "Due");
  const place = await people.readPlace(db, scope, body);
  // Nobody named: it is yours.
  const nobody = (body.assignMode === undefined || body.assignMode === null || body.assignMode === "people") && (!Array.isArray(body.assignees) || !body.assignees.length);
  const assign = nobody ? { mode: "people", rows: [{ kind: "user", id: scope.userId }] } : await people.readAssignees(db, scope, body.assignMode, body.assignees);
  if (!people.isOnlySelf(scope, assign.mode, assign.rows) && !scope.can("tasks.assign")) {
    fail(403, "You can create tasks for yourself. Assigning to others needs the \"Assign tasks\" permission.");
  }
  const link = await readProjectLink(db, scope, body);
  const requiresReview = v.requiredBoolean(body.requiresReview, "Needs review", source?.requiresReview || false);
  const task = await repo.one(db, `INSERT INTO business_tasks (business_id, title, description, category_code, priority, location_id, outlet_id, assign_mode, due_at,
      template_id, library_code, project_id, project_list_id, milestone_id, issue_id, requires_review, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
  [scope.businessId, title, description, cat, priority, place.locationId, place.outletId, assign.mode, dueAt,
    source?.templateId || null, source?.libraryCode || null, link.projectId, link.listId, link.milestoneId, fromIssue, requiresReview, scope.userId]);
  const items = body.items !== undefined && !source ? templates.readItems(body.items) : source ? source.items : [];
  await templates.insertItems(db, "business_task_items", scope.businessId, "task_id", task.id, items);
  await recurrence.recount(db, scope.businessId, task.id);
  await people.saveAssignees(db, scope, { taskId: task.id }, assign.rows);
  await repo.history(db, scope, { taskId: task.id }, "created", { title, assignMode: assign.mode, assignees: assign.rows.length, fromIssue, template: source?.name || null });
  if (link.projectId) await repo.history(db, scope, { projectId: link.projectId }, "task_added", { taskId: Number(task.id), title });
  await repo.audit(db, scope, "task.created", task.id, { title, assignMode: assign.mode });
  if (assign.rows.length) await repo.event(db, scope, "task.assigned", "task", task.id, { title, dueAt, assignees: assign.rows });
  return Number(task.id);
}

async function create(scope, body) {
  await scope.require("tasks.create");
  const taskId = await repo.transaction((db) => createIn(db, scope, body));
  return detail(scope, taskId);
}

async function update(scope, taskId, body) {
  await repo.transaction(async (db) => {
    const row = await load(db, scope, taskId, { lock: true });
    if (!rights(scope, row).edit) fail(403, "You cannot change this task");
    const changes = {};
    const set = [];
    const values = [scope.businessId, row.id];
    const put = (column, value, label) => { values.push(value); set.push(`${column} = $${values.length}`); changes[label] = value; };
    if (body.title !== undefined) put("title", v.requiredString(body.title, "Title", 160), "title");
    if (body.description !== undefined) put("description", v.optionalString(body.description, "Description", 2000), "description");
    if (body.category !== undefined) put("category_code", category(body.category), "category");
    if (body.priority !== undefined) put("priority", v.requiredEnum(body.priority, "Priority", PRIORITIES), "priority");
    if (body.dueAt !== undefined) put("due_at", momentText(body.dueAt, "Due"), "dueAt");
    if (body.requiresReview !== undefined) put("requires_review", v.requiredBoolean(body.requiresReview, "Needs review"), "requiresReview");
    if (body.placeId !== undefined || body.outletId !== undefined || body.locationId !== undefined) {
      const place = await people.readPlace(db, scope, body);
      put("outlet_id", place.outletId, "outletId");
      put("location_id", place.locationId, "locationId");
    }
    if (body.projectId !== undefined) {
      const link = await readProjectLink(db, scope, body);
      put("project_id", link.projectId, "projectId");
      put("project_list_id", link.listId, "listId");
      put("milestone_id", link.milestoneId, "milestoneId");
    }
    if (body.assignMode !== undefined || body.assignees !== undefined) {
      const assign = await people.readAssignees(db, scope, body.assignMode, body.assignees);
      if (!people.isOnlySelf(scope, assign.mode, assign.rows) && !scope.can("tasks.assign")) fail(403, "Assigning to others needs the \"Assign tasks\" permission.");
      put("assign_mode", assign.mode, "assignMode");
      await people.saveAssignees(db, scope, { taskId: row.id }, assign.rows);
      changes.assignees = assign.rows;
      if (assign.rows.length) await repo.event(db, scope, "task.assigned", "task", row.id, { title: row.title, assignees: assign.rows });
    }
    if (!set.length && !changes.assignees) return;
    if (set.length) await db.query(`UPDATE business_tasks SET ${set.join(", ")}, updated_at = now() WHERE business_id = $1 AND id = $2`, values);
    await repo.history(db, scope, { taskId: row.id }, "updated", changes);
    await repo.audit(db, scope, "task.updated", row.id, changes);
  });
  return detail(scope, taskId);
}

async function start(scope, taskId) {
  await repo.transaction(async (db) => {
    const row = await load(db, scope, taskId, { lock: true });
    if (!rights(scope, row).work) fail(403, "This task is not yours to do");
    if (row.status !== "todo") return;
    if (row.opens_at && new Date(row.opens_at) > new Date()) fail(409, "This task is not open yet");
    await db.query("UPDATE business_tasks SET status = 'in_progress', started_at = now(), started_by = $3, updated_at = now() WHERE business_id = $1 AND id = $2",
      [scope.businessId, row.id, scope.userId]);
    await repo.history(db, scope, { taskId: row.id }, "started");
  });
  return detail(scope, taskId);
}

// One checklist answer. Failing answers raise an issue (once per item).
async function answer(scope, taskId, itemId, body) {
  const result = await repo.transaction(async (db) => {
    const row = await load(db, scope, taskId, { lock: true });
    if (!rights(scope, row).work) fail(403, row.status === "missed" ? "This task was missed: its time is over" : "This task is not open for you to fill in");
    if (row.opens_at && new Date(row.opens_at) > new Date()) fail(409, "This task is not open yet");
    const item = await repo.one(db, "SELECT * FROM business_task_items WHERE business_id = $1 AND task_id = $2 AND id = $3 FOR UPDATE", [scope.businessId, row.id, id(itemId, "Item")]);
    if (!item) fail(404, "Checklist item not found");
    if (item.kind === "section") fail(400, "A section heading has no answer");
    const value = body.value;
    const note = body.note === undefined ? item.note : v.optionalString(body.note, "Note", 500);
    const answer = { value_bool: null, value_number: null, value_text: null, value_choice: null, answered: false, failed: false };
    const empty = value === null || value === undefined || value === "";
    let shown = value;
    switch (item.kind) {
      case "checkbox":
        if (!empty && typeof value !== "boolean") fail(400, "A tick is true or false");
        answer.value_bool = empty ? null : value;
        answer.answered = value === true;
        break;
      case "yes_no":
        if (!empty) {
          const said = v.requiredEnum(value, "Answer", ["yes", "no"]);
          answer.value_bool = said === "yes";
          answer.answered = true;
          answer.failed = Boolean(item.expected) && said !== item.expected;
        }
        break;
      case "number":
        if (!empty) {
          const n = v.requiredNumber(value, item.label, { min: -1e8, max: 1e8 });
          answer.value_number = n;
          answer.answered = true;
          answer.failed = (item.min_value !== null && n < Number(item.min_value)) || (item.max_value !== null && n > Number(item.max_value));
        }
        break;
      case "text":
        answer.value_text = v.optionalString(value, item.label, 1000);
        answer.answered = Boolean(answer.value_text);
        break;
      case "choice": {
        if (!empty) {
          const option = (item.options || []).find((o) => o.label === value);
          if (!option) fail(400, `Choose one of: ${(item.options || []).map((o) => o.label).join(", ")}`);
          answer.value_choice = option.label;
          answer.answered = true;
          answer.failed = Boolean(option.fail);
        }
        break;
      }
      case "photo":
      case "signature": {
        const has = await repo.one(db, "SELECT count(*)::int AS n FROM business_task_files WHERE business_id = $1 AND item_id = $2 AND removed_at IS NULL", [scope.businessId, item.id]);
        answer.answered = has.n > 0;
        shown = has.n;
        break;
      }
      default:
        break;
    }
    await db.query(`UPDATE business_task_items SET value_bool = $3, value_number = $4, value_text = $5, value_choice = $6, answered = $7, failed = $8, note = $9,
        answered_by = CASE WHEN $7 THEN $10::bigint END, answered_at = CASE WHEN $7 THEN now() END
      WHERE business_id = $1 AND id = $2`,
    [scope.businessId, item.id, answer.value_bool, answer.value_number, answer.value_text, answer.value_choice, answer.answered, answer.failed, note, scope.userId]);
    if (row.status === "todo") {
      await db.query("UPDATE business_tasks SET status = 'in_progress', started_at = now(), started_by = $3 WHERE business_id = $1 AND id = $2", [scope.businessId, row.id, scope.userId]);
      await repo.history(db, scope, { taskId: row.id }, "started");
    }
    let raised = null;
    if (answer.failed && item.raise_issue && !item.issue_id && scope.has("issues")) {
      raised = await issues.raiseFromItem(db, scope, row, item, shown);
      await db.query("UPDATE business_task_items SET issue_id = $3 WHERE business_id = $1 AND id = $2", [scope.businessId, item.id, raised.id]);
    }
    if (answer.failed || item.failed) {
      await repo.history(db, scope, { taskId: row.id }, answer.failed ? "item_failed" : "item_passed", { item: item.label, value: shown, issue: raised?.number || null });
    }
    await recurrence.recount(db, scope.businessId, row.id);
    return { raised };
  });
  const task = await detail(scope, taskId);
  return { task, raisedIssue: result.raised };
}

// Done: every required item answered, every photo the checklist asks for taken.
async function complete(scope, taskId, body = {}) {
  await repo.transaction(async (db) => {
    const row = await load(db, scope, taskId, { lock: true });
    if (!rights(scope, row).work) fail(403, row.status === "missed" ? "This task was missed: its time is over" : "This task is not open for you to finish");
    if (row.opens_at && new Date(row.opens_at) > new Date()) fail(409, "This task is not open yet");
    const missing = await repo.all(db, `SELECT i.label FROM business_task_items i WHERE i.business_id = $1 AND i.task_id = $2 AND i.kind <> 'section'
      AND ((i.required AND NOT i.answered)
        OR (i.photo_required AND NOT EXISTS (SELECT 1 FROM business_task_files f WHERE f.business_id = i.business_id AND f.item_id = i.id AND f.removed_at IS NULL)))
      ORDER BY i.position`, [scope.businessId, row.id]);
    if (missing.length) fail(409, `Still to do: ${missing.slice(0, 3).map((m) => m.label).join("; ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}`, { missing: missing.map((m) => m.label) });
    const note = v.optionalString(body.note, "Note", 2000);
    await db.query(`UPDATE business_tasks SET status = 'done', completed_at = now(), completed_by = $3,
        started_at = COALESCE(started_at, now()), started_by = COALESCE(started_by, $3),
        review_status = CASE WHEN requires_review THEN 'pending' END, reviewed_by = NULL, reviewed_at = NULL, updated_at = now()
      WHERE business_id = $1 AND id = $2`, [scope.businessId, row.id, scope.userId]);
    if (note) await db.query("INSERT INTO business_task_comments (business_id, task_id, body, created_by) VALUES ($1, $2, $3, $4)", [scope.businessId, row.id, note, scope.userId]);
    const late = row.due_at && new Date(row.due_at) < new Date();
    await repo.history(db, scope, { taskId: row.id }, "completed", { late, failed: Number(row.failed_count), score: row.score_percent === null ? null : Number(row.score_percent) });
    await repo.audit(db, scope, "task.completed", row.id, { title: row.title, late });
    if (row.project_id) await repo.history(db, scope, { projectId: row.project_id }, "task_done", { taskId: Number(row.id), title: row.title });
  });
  return detail(scope, taskId);
}

async function review(scope, taskId, body) {
  await scope.require("tasks.review");
  const decision = v.requiredEnum(body.decision, "Decision", ["approve", "changes"]);
  const note = v.optionalString(body.note, "Note", 500);
  if (decision === "changes" && !note) fail(400, "Say what needs to change");
  await repo.transaction(async (db) => {
    const row = await load(db, scope, taskId, { lock: true });
    if (row.status !== "done" || row.review_status !== "pending") fail(409, "This task is not waiting for a review");
    if (Number(row.completed_by) === scope.userId && !scope.can("tasks.manage")) fail(403, "Someone else must review a task you finished");
    if (decision === "approve") {
      await db.query("UPDATE business_tasks SET review_status = 'approved', reviewed_by = $3, reviewed_at = now(), review_note = $4, updated_at = now() WHERE business_id = $1 AND id = $2",
        [scope.businessId, row.id, scope.userId, note]);
    } else {
      await db.query(`UPDATE business_tasks SET status = 'in_progress', completed_at = NULL, completed_by = NULL, review_status = 'changes_requested',
          reviewed_by = $3, reviewed_at = now(), review_note = $4, updated_at = now() WHERE business_id = $1 AND id = $2`, [scope.businessId, row.id, scope.userId, note]);
    }
    await repo.history(db, scope, { taskId: row.id }, decision === "approve" ? "approved" : "changes_requested", { note });
    await repo.audit(db, scope, decision === "approve" ? "task.approved" : "task.sent_back", row.id, { title: row.title, note });
  });
  return detail(scope, taskId);
}

async function cancel(scope, taskId, body) {
  const reason = v.requiredString(body.reason, "Reason", 300);
  await repo.transaction(async (db) => {
    const row = await load(db, scope, taskId, { lock: true });
    if (!rights(scope, row).cancel) fail(403, "You cannot cancel this task");
    await db.query("UPDATE business_tasks SET status = 'cancelled', cancelled_at = now(), cancelled_by = $3, cancel_reason = $4, updated_at = now() WHERE business_id = $1 AND id = $2",
      [scope.businessId, row.id, scope.userId, reason]);
    await repo.history(db, scope, { taskId: row.id }, "cancelled", { reason });
    await repo.audit(db, scope, "task.cancelled", row.id, { title: row.title, reason });
  });
  return detail(scope, taskId);
}

// A manager opens a done, missed or cancelled task again (a missed log done late on paper, say).
async function reopen(scope, taskId, body) {
  await scope.require("tasks.manage");
  const reason = v.requiredString(body.reason, "Reason", 300);
  await repo.transaction(async (db) => {
    const row = await load(db, scope, taskId, { lock: true });
    if (!["done", "missed", "cancelled"].includes(row.status)) fail(409, "This task is still open");
    await db.query(`UPDATE business_tasks SET status = CASE WHEN started_at IS NULL THEN 'todo' ELSE 'in_progress' END, completed_at = NULL, completed_by = NULL,
        cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL, review_status = NULL, reviewed_by = NULL, reviewed_at = NULL,
        closes_at = CASE WHEN closes_at < now() THEN now() + interval '1 day' ELSE closes_at END, updated_at = now()
      WHERE business_id = $1 AND id = $2`, [scope.businessId, row.id]);
    await repo.history(db, scope, { taskId: row.id }, "reopened", { reason, was: row.status });
    await repo.audit(db, scope, "task.reopened", row.id, { title: row.title, reason });
  });
  return detail(scope, taskId);
}

async function remove(scope, taskId) {
  await scope.require("tasks.manage");
  await repo.transaction(async (db) => {
    const row = await load(db, scope, taskId, { lock: true });
    if (row.schedule_id) fail(409, "A recurring task's day cannot be deleted. Cancel it instead.");
    if (Number(row.answered_count) > 0 || ["done", "missed"].includes(row.status)) fail(409, "This task has answers or is finished. Cancel it instead.");
    await db.query("UPDATE business_issues SET source_task_id = NULL WHERE business_id = $1 AND source_task_id = $2", [scope.businessId, row.id]);
    await db.query("DELETE FROM business_tasks WHERE business_id = $1 AND id = $2", [scope.businessId, row.id]);
    await repo.audit(db, scope, "task.deleted", row.id, { title: row.title });
  });
  return { deleted: Number(taskId) };
}

async function comment(scope, taskId, body) {
  const text = v.requiredString(body.body, "Comment", 2000);
  await repo.transaction(async (db) => {
    const row = await load(db, scope, taskId);
    await db.query("INSERT INTO business_task_comments (business_id, task_id, body, created_by) VALUES ($1, $2, $3, $4)", [scope.businessId, row.id, text, scope.userId]);
  });
  return commentsOf(repo.pool, scope, { taskId: id(taskId, "Task") });
}

module.exports = {
  list, mine, calendar, detail, load, rights, create, createIn, update, start, answer, complete, review, cancel, reopen, remove, comment,
  filesOf, commentsOf, historyOf, shape,
};
