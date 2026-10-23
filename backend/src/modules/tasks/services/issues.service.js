const repo = require("../repositories/tasks.repository");
const people = require("./people.service");
const { fail, id, optionalId, v, category, momentText, dateText, page, search, SEVERITIES, ISSUE_STATUSES } = require("./common");

// Issues: something wrong that someone must fix — a fridge too warm, a leak,
// a broken scale, a guest complaint about hygiene.
//
//   open → in_progress → resolved → closed      (resolved or closed can be reopened)
//
// Reported by hand (with photos), raised by a failed checklist answer, or
// raised from a restaurant log-book entry. "Convert to a task" makes a task
// that points back at the issue.

const LOCK_KEY = 72018;

// Visible: issues.view sees all (within their outlet); others see what they
// reported or are assigned.
function visibleSql(scope, p, i = "i") {
  const outlet = scope.outletScope ? `(${i}.outlet_id IS NULL OR ${i}.outlet_id = ${p.add(scope.outletScope)})` : "TRUE";
  if (scope.can("issues.view")) return outlet;
  const uid = p.add(scope.userId);
  return `(${outlet} AND (${i}.reported_by = ${uid} OR ${i}.assignee_user_id = ${uid}))`;
}

const columns = `i.id, i.number, i.title, i.description, i.category_code AS category, i.severity, i.status, i.outlet_id, i.location_id,
  ${people.placeNameSql("i")} AS place_name, i.asset_label, i.assignee_user_id, (SELECT name FROM users WHERE id = i.assignee_user_id) AS assignee_name,
  i.due_at, i.reported_by, (SELECT name FROM users WHERE id = i.reported_by) AS reported_by_name, i.reported_at,
  i.resolved_at, (SELECT name FROM users WHERE id = i.resolved_by) AS resolved_by_name, i.resolution_note,
  i.closed_at, (SELECT name FROM users WHERE id = i.closed_by) AS closed_by_name,
  i.source_task_id, (SELECT title FROM business_tasks t WHERE t.business_id = i.business_id AND t.id = i.source_task_id) AS source_task_title,
  i.source_task_item_id, i.source_logbook_entry_id,
  (SELECT count(*) FROM business_task_files f WHERE f.business_id = i.business_id AND f.issue_id = i.id AND f.removed_at IS NULL) AS photo_count,
  (SELECT json_agg(json_build_object('id', t.id, 'title', t.title, 'status', t.status) ORDER BY t.id) FROM business_tasks t WHERE t.business_id = i.business_id AND t.issue_id = i.id) AS tasks,
  i.updated_at`;

const shape = (r) => ({
  id: Number(r.id), number: Number(r.number), code: `ISS-${String(r.number).padStart(4, "0")}`, title: r.title, description: r.description,
  category: r.category, severity: r.severity, status: r.status,
  placeId: Number(r.outlet_id || r.location_id) || null, placeName: r.place_name || null, assetLabel: r.asset_label,
  assigneeId: r.assignee_user_id ? Number(r.assignee_user_id) : null, assigneeName: r.assignee_name || null,
  dueAt: r.due_at, overdue: ["open", "in_progress"].includes(r.status) && r.due_at && new Date(r.due_at) < new Date(),
  reportedById: Number(r.reported_by), reportedByName: r.reported_by_name, reportedAt: r.reported_at,
  ageDays: Math.floor((Date.now() - new Date(r.reported_at).getTime()) / 86400000),
  resolvedAt: r.resolved_at, resolvedByName: r.resolved_by_name || null, resolutionNote: r.resolution_note,
  closedAt: r.closed_at, closedByName: r.closed_by_name || null,
  sourceTaskId: r.source_task_id ? Number(r.source_task_id) : null, sourceTaskTitle: r.source_task_title || null,
  sourceTaskItemId: r.source_task_item_id ? Number(r.source_task_item_id) : null,
  sourceLogbookEntryId: r.source_logbook_entry_id ? Number(r.source_logbook_entry_id) : null,
  photoCount: Number(r.photo_count || 0), tasks: (r.tasks || []).map((t) => ({ id: Number(t.id), title: t.title, status: t.status })),
  updatedAt: r.updated_at,
});

async function nextNumber(db, scope) {
  await db.query("SELECT pg_advisory_xact_lock($1, $2::int)", [LOCK_KEY, scope.businessId]);
  return Number((await repo.one(db, "SELECT COALESCE(max(number), 0) + 1 AS n FROM business_issues WHERE business_id = $1", [scope.businessId])).n);
}

async function insert(db, scope, data) {
  const number = await nextNumber(db, scope);
  const row = await repo.one(db, `INSERT INTO business_issues (business_id, number, title, description, category_code, severity, location_id, outlet_id, asset_label,
      assignee_user_id, due_at, reported_by, source_task_id, source_task_item_id, source_logbook_entry_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id, number`,
  [scope.businessId, number, data.title, data.description, data.category, data.severity, data.locationId || null, data.outletId || null, data.assetLabel || null,
    data.assigneeId || null, data.dueAt || null, scope.userId, data.sourceTaskId || null, data.sourceItemId || null, data.logbookEntryId || null]);
  await repo.history(db, scope, { issueId: row.id }, "reported", { title: data.title, severity: data.severity, from: data.from || "hand" });
  await repo.audit(db, scope, "issue.reported", row.id, { number, title: data.title, severity: data.severity });
  await repo.event(db, scope, "issue.reported", "issue", row.id, { number, title: data.title, severity: data.severity, assigneeId: data.assigneeId || null });
  return { id: Number(row.id), number: Number(row.number) };
}

// A failed checklist answer: "Walk-in chiller: 9 °C (allowed 0 to 5)".
async function raiseFromItem(db, scope, task, item, shown) {
  const range = item.kind === "number"
    ? ` (allowed ${item.min_value === null ? "up to" : Number(item.min_value)}${item.min_value !== null && item.max_value !== null ? " to " : ""}${item.max_value === null ? " or more" : Number(item.max_value)}${item.unit ? ` ${item.unit}` : ""})`
    : "";
  const value = item.kind === "number" ? `${shown}${item.unit ? ` ${item.unit}` : ""}` : String(shown);
  return insert(db, scope, {
    title: `${item.label}: ${value}${range}`.slice(0, 200),
    description: `Failed on the checklist "${task.title}"${task.occurrence_date ? ` of ${task.occurrence_date}` : ""}.`,
    category: task.category, severity: item.fail_severity,
    outletId: task.outlet_id, locationId: task.location_id,
    sourceTaskId: task.id, sourceItemId: item.id, from: "checklist",
  });
}

async function list(scope, query = {}) {
  const { limit, offset } = page(query);
  const p = new repo.Params([scope.businessId]);
  const where = ["i.business_id = $1", visibleSql(scope, p, "i")];
  const statuses = v.enumList(query.status, "Status", [...ISSUE_STATUSES, "active"]);
  if (statuses) {
    const list = statuses.flatMap((s) => (s === "active" ? ["open", "in_progress"] : [s]));
    where.push(`i.status = ANY(${p.add(list)}::text[])`);
  }
  if (query.severity) where.push(`i.severity = ${p.add(v.requiredEnum(query.severity, "Severity", SEVERITIES))}`);
  if (query.category) where.push(`i.category_code = ${p.add(category(query.category))}`);
  if (query.place) where.push(scope.world === "restaurant" ? `i.outlet_id = ${p.add(id(query.place, "Place"))}` : `i.location_id = ${p.add(id(query.place, "Place"))}`);
  if (query.assignee === "me") where.push(`i.assignee_user_id = ${p.add(scope.userId)}`);
  else if (query.assignee === "none") where.push("i.assignee_user_id IS NULL");
  else if (query.assignee) where.push(`i.assignee_user_id = ${p.add(id(query.assignee, "Assignee"))}`);
  if (query.reported === "me") where.push(`i.reported_by = ${p.add(scope.userId)}`);
  const from = dateText(query.from, "From"), to = dateText(query.to, "To");
  if (from || to) {
    const tz = p.add(scope.timezone);
    if (from) where.push(`(i.reported_at AT TIME ZONE ${tz})::date >= ${p.add(from)}`);
    if (to) where.push(`(i.reported_at AT TIME ZONE ${tz})::date <= ${p.add(to)}`);
  }
  const q = search(query.q);
  if (q) where.push(`(i.title ILIKE '%' || ${p.add(q)}::text || '%' OR i.asset_label ILIKE '%' || ${p.add(q)}::text || '%' OR ('ISS-' || lpad(i.number::text, 4, '0')) ILIKE '%' || ${p.add(q)}::text || '%')`);
  const order = query.sort === "oldest" ? "i.id" : query.sort === "severity"
    ? "array_position(ARRAY['critical','high','medium','low'], i.severity), i.id DESC"
    : "array_position(ARRAY['open','in_progress','resolved','closed'], i.status), array_position(ARRAY['critical','high','medium','low'], i.severity), i.id DESC";
  const rows = await repo.all(repo.pool, `SELECT ${columns}, count(*) OVER () AS total FROM business_issues i WHERE ${where.join(" AND ")}
    ORDER BY ${order} LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`, p.values);
  return { rows: rows.map(shape), total: rows.length ? Number(rows[0].total) : 0, limit, offset };
}

async function load(db, scope, issueId, { lock = false } = {}) {
  const p = new repo.Params([scope.businessId, id(issueId, "Issue")]);
  const visible = visibleSql(scope, p, "i");
  const row = await repo.one(db, `SELECT ${columns}, (${visible}) AS visible FROM business_issues i WHERE i.business_id = $1 AND i.id = $2 ${lock ? "FOR UPDATE OF i" : ""}`, p.values);
  if (!row || !row.visible) fail(404, "Issue not found");
  return row;
}

function rights(scope, row) {
  const active = ["open", "in_progress"].includes(row.status);
  const assignee = Number(row.assignee_user_id) === scope.userId;
  return {
    edit: active && (scope.can("issues.assign") || Number(row.reported_by) === scope.userId),
    assign: active && scope.can("issues.assign"),
    work: active && (assignee || scope.can("issues.assign")),
    resolve: active && (assignee || scope.can("issues.assign")),
    close: row.status === "resolved" && scope.can("issues.review"),
    reopen: ["resolved", "closed"].includes(row.status) && (scope.can("issues.review") || Number(row.reported_by) === scope.userId),
    convert: active && scope.can("tasks.create") && scope.can("issues.assign"),
    remove: scope.can("issues.manage"),
  };
}

async function detail(scope, issueId) {
  const row = await load(repo.pool, scope, issueId);
  const tasks = require("./tasks.service");
  const [files, comments, history] = await Promise.all([
    tasks.filesOf(repo.pool, scope, { issueId: row.id }), tasks.commentsOf(repo.pool, scope, { issueId: row.id }), tasks.historyOf(repo.pool, scope, { issueId: row.id }),
  ]);
  let logbook = null;
  if (row.source_logbook_entry_id && scope.world === "restaurant") {
    logbook = await repo.one(repo.pool, "SELECT id, body, category, business_date::text AS business_date, shift_label FROM logbook_entries WHERE id = $1 AND restaurant_id = $2",
      [row.source_logbook_entry_id, scope.restaurantId]);
  }
  return { ...shape(row), files, comments, history, logbook, can: rights(scope, row) };
}

function readIssue(body, partial = false) {
  const out = {};
  if (!partial || body.title !== undefined) out.title = v.requiredString(body.title, "What is wrong", 200);
  if (!partial || body.description !== undefined) out.description = v.optionalString(body.description, "Details", 2000);
  if (!partial || body.category !== undefined) out.category = category(body.category, "maintenance");
  if (!partial || body.severity !== undefined) out.severity = v.optionalEnum(body.severity, "Severity", SEVERITIES, "medium");
  if (!partial || body.assetLabel !== undefined) out.assetLabel = v.optionalString(body.assetLabel, "Equipment / asset", 120);
  if (!partial || body.dueAt !== undefined) out.dueAt = momentText(body.dueAt, "Fix by");
  return out;
}

async function create(scope, body) {
  await scope.require("issues.create");
  const data = readIssue(body);
  const created = await repo.transaction(async (db) => {
    const place = await people.readPlace(db, scope, body);
    const assigneeId = optionalId(body.assigneeId, "Assign to");
    if (assigneeId) {
      if (!scope.can("issues.assign") && assigneeId !== scope.userId) fail(403, "Assigning an issue needs the \"Assign and work on issues\" permission");
      await people.requireUser(db, scope, assigneeId, "Assign to");
    }
    return insert(db, scope, { ...data, ...place, assigneeId, from: "hand" });
  });
  return detail(scope, created.id);
}

async function update(scope, issueId, body) {
  await repo.transaction(async (db) => {
    const row = await load(db, scope, issueId, { lock: true });
    const can = rights(scope, row);
    if (!can.edit) fail(403, "You cannot change this issue");
    const data = readIssue(body, true);
    const set = [], values = [scope.businessId, row.id];
    const put = (column, value) => { values.push(value); set.push(`${column} = $${values.length}`); };
    if (data.title !== undefined) put("title", data.title);
    if (data.description !== undefined) put("description", data.description);
    if (data.category !== undefined) put("category_code", data.category);
    if (data.severity !== undefined) put("severity", data.severity);
    if (data.assetLabel !== undefined) put("asset_label", data.assetLabel);
    if (data.dueAt !== undefined) put("due_at", data.dueAt);
    if (body.placeId !== undefined) {
      const place = await people.readPlace(db, scope, body);
      put("outlet_id", place.outletId);
      put("location_id", place.locationId);
    }
    if (body.assigneeId !== undefined) {
      if (!can.assign) fail(403, "Assigning an issue needs the \"Assign and work on issues\" permission");
      const assigneeId = optionalId(body.assigneeId, "Assign to");
      if (assigneeId) await people.requireUser(db, scope, assigneeId, "Assign to");
      put("assignee_user_id", assigneeId);
      data.assigneeId = assigneeId;
      if (assigneeId) await repo.event(db, scope, "issue.assigned", "issue", row.id, { number: Number(row.number), title: row.title, assigneeId });
    }
    if (!set.length) return;
    await db.query(`UPDATE business_issues SET ${set.join(", ")}, updated_at = now() WHERE business_id = $1 AND id = $2`, values);
    await repo.history(db, scope, { issueId: row.id }, body.assigneeId !== undefined && set.length === 1 ? "assigned" : "updated", data);
    await repo.audit(db, scope, "issue.updated", row.id, data);
  });
  return detail(scope, issueId);
}

// Moves along the life of an issue.
async function setStatus(scope, issueId, body) {
  const status = v.requiredEnum(body.status, "Status", ISSUE_STATUSES);
  const note = v.optionalString(body.note, "Note", 1000);
  await repo.transaction(async (db) => {
    const row = await load(db, scope, issueId, { lock: true });
    const can = rights(scope, row);
    if (row.status === status) return;
    if (status === "in_progress" && row.status === "open" && !can.work) fail(403, "Only the person assigned (or a manager) can start work on this");
    if (status === "resolved" && !can.resolve) fail(403, "Only the person assigned (or a manager) can mark this fixed");
    if (status === "resolved" && !note) fail(400, "Say what was done to fix it");
    if (status === "closed" && !can.close) fail(row.status === "resolved" ? 403 : 409, row.status === "resolved" ? "Closing an issue needs the \"Close and reopen issues\" permission" : "Mark it fixed (resolved) before closing it");
    if (status === "open" && !can.reopen && row.status !== "in_progress") fail(403, "You cannot reopen this issue");
    if (status === "open" && row.status === "in_progress" && !can.work) fail(403, "You cannot change this issue");
    if (status === "in_progress" && ["resolved", "closed"].includes(row.status)) fail(409, "Reopen it first");
    await db.query(`UPDATE business_issues SET status = $3,
        resolved_at = CASE WHEN $3 IN ('resolved', 'closed') THEN COALESCE(resolved_at, now()) END,
        resolved_by = CASE WHEN $3 IN ('resolved', 'closed') THEN COALESCE(resolved_by, $4) END,
        resolution_note = CASE WHEN $3 = 'resolved' THEN $5 WHEN $3 = 'closed' THEN resolution_note END,
        closed_at = CASE WHEN $3 = 'closed' THEN now() END, closed_by = CASE WHEN $3 = 'closed' THEN $4::bigint END,
        assignee_user_id = CASE WHEN $3 = 'in_progress' AND assignee_user_id IS NULL THEN $4 ELSE assignee_user_id END,
        updated_at = now()
      WHERE business_id = $1 AND id = $2`, [scope.businessId, row.id, status, scope.userId, note]);
    await repo.history(db, scope, { issueId: row.id }, status === "open" ? "reopened" : status, { note, was: row.status });
    await repo.audit(db, scope, `issue.${status === "open" ? "reopened" : status}`, row.id, { number: Number(row.number), note });
  });
  return detail(scope, issueId);
}

// Convert to a task: the work to fix it, assigned and due; the issue moves to in progress.
async function convert(scope, issueId, body) {
  await scope.require("tasks.create");
  const tasks = require("./tasks.service");
  const taskId = await repo.transaction(async (db) => {
    const row = await load(db, scope, issueId, { lock: true });
    if (!rights(scope, row).convert) fail(403, "You cannot make a task from this issue");
    const made = await tasks.createIn(db, scope, {
      title: body.title || `Fix: ${row.title}`.slice(0, 160),
      description: body.description ?? [row.description, row.asset_label ? `Equipment: ${row.asset_label}` : null].filter(Boolean).join("\n") ?? null,
      category: row.category, priority: { critical: "urgent", high: "high", medium: "normal", low: "low" }[row.severity],
      placeId: row.outlet_id || row.location_id || undefined, dueAt: body.dueAt ?? (row.due_at ? new Date(row.due_at).toISOString() : undefined),
      assignMode: body.assignMode, assignees: body.assignees ?? (row.assignee_user_id ? [{ kind: "user", id: Number(row.assignee_user_id) }] : undefined),
      templateId: body.templateId, libraryCode: body.libraryCode,
    }, { fromIssue: row.id });
    if (row.status === "open") await db.query("UPDATE business_issues SET status = 'in_progress', updated_at = now() WHERE business_id = $1 AND id = $2", [scope.businessId, row.id]);
    await repo.history(db, scope, { issueId: row.id }, "task_made", { taskId: made });
    return made;
  });
  return { taskId, issue: await detail(scope, issueId) };
}

async function comment(scope, issueId, body) {
  const text = v.requiredString(body.body, "Comment", 2000);
  const tasks = require("./tasks.service");
  await repo.transaction(async (db) => {
    const row = await load(db, scope, issueId);
    await db.query("INSERT INTO business_task_comments (business_id, issue_id, body, created_by) VALUES ($1, $2, $3, $4)", [scope.businessId, row.id, text, scope.userId]);
  });
  return tasks.commentsOf(repo.pool, scope, { issueId: id(issueId, "Issue") });
}

async function remove(scope, issueId) {
  await scope.require("issues.manage");
  await repo.transaction(async (db) => {
    const row = await load(db, scope, issueId, { lock: true });
    if ((row.tasks || []).length) fail(409, "A task was made from this issue. Close the issue instead.");
    await db.query("UPDATE business_task_items SET issue_id = NULL WHERE business_id = $1 AND issue_id = $2", [scope.businessId, row.id]);
    await db.query("DELETE FROM business_issues WHERE business_id = $1 AND id = $2", [scope.businessId, row.id]);
    await repo.audit(db, scope, "issue.deleted", row.id, { number: Number(row.number), title: row.title });
  });
  return { deleted: Number(issueId) };
}

// Restaurant: a log-book entry that needs work becomes an issue (once). The
// entry stays the shift's note; the issue tracks the fix.
const LOGBOOK_CATEGORY = { maintenance: "maintenance", guest: "others", stock: "stock_check", staff: "hiring", other: "others" };
async function fromLogbook(scope, entryId, body = {}) {
  if (scope.world !== "restaurant") fail(404, "The log book belongs to restaurants");
  await scope.require("issues.create");
  const created = await repo.transaction(async (db) => {
    const entry = await repo.one(db, "SELECT * FROM logbook_entries WHERE id = $1 AND restaurant_id = $2 FOR UPDATE", [id(entryId, "Log book entry"), scope.restaurantId]);
    if (!entry || (scope.outletScope && entry.outlet_id && Number(entry.outlet_id) !== scope.outletScope)) fail(404, "Log book entry not found");
    const existing = await repo.one(db, "SELECT id FROM business_issues WHERE source_logbook_entry_id = $1", [entry.id]);
    if (existing) return { id: Number(existing.id), existed: true };
    return insert(db, scope, {
      title: v.optionalString(body.title, "What is wrong", 200) || entry.body.split(/[.\n]/)[0].slice(0, 200),
      description: entry.body, category: LOGBOOK_CATEGORY[entry.category] || "others",
      severity: v.optionalEnum(body.severity, "Severity", SEVERITIES, "medium"), outletId: entry.outlet_id, logbookEntryId: entry.id, from: "logbook",
    });
  });
  return detail(scope, created.id);
}

module.exports = { list, detail, load, create, update, setStatus, convert, comment, remove, fromLogbook, raiseFromItem, visibleSql };
