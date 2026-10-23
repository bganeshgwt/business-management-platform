const repo = require("../repositories/tasks.repository");
const library = require("../library");
const people = require("./people.service");
const { fail, id, optionalId, v, dateText, localToday, addDays, search, PROJECT_STATUSES } = require("./common");

// Projects: a bigger job with an owner, members, start and end dates,
// milestones and task lists. Progress = done tasks ÷ tasks not cancelled.
// projects.view sees every project; everyone else sees the ones they belong to.

const progressSql = (pr = "p") => `(SELECT json_build_object(
    'total', count(*) FILTER (WHERE t.status <> 'cancelled'),
    'done', count(*) FILTER (WHERE t.status = 'done'),
    'overdue', count(*) FILTER (WHERE t.status IN ('todo', 'in_progress') AND t.due_at < now()))
  FROM business_tasks t WHERE t.business_id = ${pr}.business_id AND t.project_id = ${pr}.id)`;

const columns = `p.id, p.name, p.description, p.owner_user_id, (SELECT name FROM users WHERE id = p.owner_user_id) AS owner_name, p.status,
  p.start_on::text AS start_on, p.end_on::text AS end_on, p.outlet_id, p.location_id, ${people.placeNameSql("p")} AS place_name, p.template_code,
  p.completed_at, p.created_at, p.updated_at, ${progressSql("p")} AS progress,
  (SELECT count(*) FROM business_project_members m WHERE m.business_id = p.business_id AND m.project_id = p.id) AS member_count,
  (SELECT json_build_object('total', count(*), 'done', count(*) FILTER (WHERE done_at IS NOT NULL),
     'next', (SELECT json_build_object('name', name, 'dueOn', due_on::text) FROM business_project_milestones x WHERE x.business_id = p.business_id AND x.project_id = p.id AND x.done_at IS NULL ORDER BY due_on NULLS LAST, position LIMIT 1))
   FROM business_project_milestones ms WHERE ms.business_id = p.business_id AND ms.project_id = p.id) AS milestones_summary`;

const shape = (r, scope) => {
  const progress = r.progress || { total: 0, done: 0, overdue: 0 };
  const total = Number(progress.total), done = Number(progress.done);
  return {
    id: Number(r.id), name: r.name, description: r.description, ownerId: Number(r.owner_user_id), ownerName: r.owner_name, status: r.status,
    startOn: r.start_on, endOn: r.end_on, placeId: Number(r.outlet_id || r.location_id) || null, placeName: r.place_name || null, templateCode: r.template_code,
    completedAt: r.completed_at, createdAt: r.created_at,
    taskCount: total, doneCount: done, overdueCount: Number(progress.overdue), progressPercent: total ? Math.round((100 * done) / total) : 0,
    memberCount: Number(r.member_count || 0),
    milestones: r.milestones_summary ? { total: Number(r.milestones_summary.total), done: Number(r.milestones_summary.done), next: r.milestones_summary.next } : null,
    late: !["completed", "cancelled"].includes(r.status) && r.end_on && r.end_on < localToday(scope.timezone),
    mine: Boolean(r.member),
  };
};

function visibleSql(scope, p, pr = "p") {
  const outlet = scope.outletScope ? `(${pr}.outlet_id IS NULL OR ${pr}.outlet_id = ${p.add(scope.outletScope)})` : "TRUE";
  if (scope.can("projects.view")) return outlet;
  return `(${outlet} AND EXISTS (SELECT 1 FROM business_project_members m WHERE m.business_id = ${pr}.business_id AND m.project_id = ${pr}.id AND m.user_id = ${p.add(scope.userId)}))`;
}

async function list(scope, query = {}) {
  const p = new repo.Params([scope.businessId]);
  const where = ["p.business_id = $1", visibleSql(scope, p)];
  const statuses = v.enumList(query.status, "Status", [...PROJECT_STATUSES, "live"]);
  if (statuses) where.push(`p.status = ANY(${p.add(statuses.flatMap((s) => (s === "live" ? ["planning", "active", "on_hold"] : [s])))}::text[])`);
  const q = search(query.q);
  if (q) where.push(`p.name ILIKE '%' || ${p.add(q)}::text || '%'`);
  const member = `EXISTS (SELECT 1 FROM business_project_members m WHERE m.business_id = p.business_id AND m.project_id = p.id AND m.user_id = ${p.add(scope.userId)}) AS member`;
  const rows = await repo.all(repo.pool, `SELECT ${columns}, ${member} FROM business_projects p WHERE ${where.join(" AND ")}
    ORDER BY array_position(ARRAY['active','planning','on_hold','completed','cancelled'], p.status), p.end_on NULLS LAST, p.id DESC LIMIT 500`, p.values);
  return rows.map((r) => shape(r, scope));
}

async function load(db, scope, projectId, { lock = false } = {}) {
  const p = new repo.Params([scope.businessId, id(projectId, "Project")]);
  const visible = visibleSql(scope, p);
  const member = `EXISTS (SELECT 1 FROM business_project_members m WHERE m.business_id = p.business_id AND m.project_id = p.id AND m.user_id = ${p.add(scope.userId)}) AS member`;
  const row = await repo.one(db, `SELECT ${columns}, ${member}, (${visible}) AS visible FROM business_projects p WHERE p.business_id = $1 AND p.id = $2 ${lock ? "FOR UPDATE OF p" : ""}`, p.values);
  if (!row || !row.visible) fail(404, "Project not found");
  return row;
}

const canEdit = (scope, row) => scope.can("projects.manage") || Number(row.owner_user_id) === scope.userId;

async function detail(scope, projectId) {
  const row = await load(repo.pool, scope, projectId);
  const tasks = require("./tasks.service");
  const p = new repo.Params([scope.businessId, row.id]);
  const [members, milestones, lists, taskRows, comments, history] = await Promise.all([
    repo.all(repo.pool, `SELECT m.user_id, m.role, u.name FROM business_project_members m JOIN users u ON u.id = m.user_id
      WHERE m.business_id = $1 AND m.project_id = $2 ORDER BY m.role DESC, u.name`, [scope.businessId, row.id]),
    repo.all(repo.pool, `SELECT ms.id, ms.name, ms.due_on::text AS due_on, ms.position, ms.done_at, u.name AS done_by_name,
        (SELECT count(*) FROM business_tasks t WHERE t.business_id = ms.business_id AND t.milestone_id = ms.id AND t.status <> 'cancelled') AS task_count,
        (SELECT count(*) FROM business_tasks t WHERE t.business_id = ms.business_id AND t.milestone_id = ms.id AND t.status = 'done') AS done_count
      FROM business_project_milestones ms LEFT JOIN users u ON u.id = ms.done_by WHERE ms.business_id = $1 AND ms.project_id = $2 ORDER BY ms.due_on NULLS LAST, ms.position, ms.id`, [scope.businessId, row.id]),
    repo.all(repo.pool, "SELECT id, name, position FROM business_project_lists WHERE business_id = $1 AND project_id = $2 ORDER BY position, id", [scope.businessId, row.id]),
    repo.all(repo.pool, `SELECT t.id, t.title, t.status, t.priority, t.due_at, t.project_list_id, t.milestone_id, t.item_count, t.answered_count, t.completed_at,
        ${people.assigneeNamesSql("t")} AS assignee_names, ${people.mineSql(scope, p, "t")} AS mine
      FROM business_tasks t WHERE t.business_id = $1 AND t.project_id = $2 ORDER BY t.status = 'done', t.due_at NULLS LAST, t.id`, p.values),
    tasks.commentsOf(repo.pool, scope, { projectId: row.id }),
    tasks.historyOf(repo.pool, scope, { projectId: row.id }),
  ]);
  const editable = canEdit(scope, row);
  return {
    ...shape(row, scope),
    members: members.map((m) => ({ userId: Number(m.user_id), name: m.name, role: m.role })),
    milestoneList: milestones.map((m) => ({ id: Number(m.id), name: m.name, dueOn: m.due_on, position: m.position, doneAt: m.done_at, doneByName: m.done_by_name,
      taskCount: Number(m.task_count), doneCount: Number(m.done_count) })),
    lists: lists.map((l) => ({ id: Number(l.id), name: l.name, position: l.position })),
    tasks: taskRows.map((t) => ({ id: Number(t.id), title: t.title, status: t.status, priority: t.priority, dueAt: t.due_at,
      overdue: ["todo", "in_progress"].includes(t.status) && t.due_at && new Date(t.due_at) < new Date(),
      listId: t.project_list_id ? Number(t.project_list_id) : null, milestoneId: t.milestone_id ? Number(t.milestone_id) : null,
      itemCount: Number(t.item_count), answeredCount: Number(t.answered_count), assigneeNames: t.assignee_names, mine: Boolean(t.mine) })),
    comments, history,
    can: { edit: editable, addTask: (Boolean(row.member) || scope.can("projects.manage")) && scope.can("tasks.create") && ["planning", "active", "on_hold"].includes(row.status) },
  };
}

function readProject(body, partial = false) {
  const out = {};
  if (!partial || body.name !== undefined) out.name = v.requiredString(body.name, "Project name", 120);
  if (!partial || body.description !== undefined) out.description = v.optionalString(body.description, "Description", 2000);
  if (!partial || body.startOn !== undefined) out.startOn = dateText(body.startOn, "Starts");
  if (!partial || body.endOn !== undefined) out.endOn = dateText(body.endOn, "Ends");
  if (out.startOn && out.endOn && out.endOn < out.startOn) fail(400, "The project ends before it starts");
  return out;
}

async function addMembers(db, scope, projectId, userIds, ownerId) {
  for (const userId of new Set([ownerId, ...userIds])) {
    await people.requireUser(db, scope, userId, "Member");
    await db.query(`INSERT INTO business_project_members (business_id, project_id, user_id, role) VALUES ($1, $2, $3, $4)
      ON CONFLICT (business_id, project_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [scope.businessId, projectId, userId, userId === ownerId ? "owner" : "member"]);
  }
}

// New project, blank or from a project template (milestones, lists and tasks made for it).
async function create(scope, body) {
  await scope.require("projects.create");
  const data = readProject(body);
  const template = body.templateCode ? library.getProject(String(body.templateCode)) : null;
  if (body.templateCode && !template) fail(400, "Project template not found");
  const projectId = await repo.transaction(async (db) => {
    const place = await people.readPlace(db, scope, body);
    const ownerId = optionalId(body.ownerId, "Owner") || scope.userId;
    if (ownerId !== scope.userId && !scope.can("projects.manage")) fail(403, "Only someone who can change any project can name another owner");
    const startOn = data.startOn || localToday(scope.timezone);
    const endOn = data.endOn || (template ? addDays(startOn, template.days) : null);
    const status = v.optionalEnum(body.status, "Status", ["planning", "active"], "active");
    const row = await repo.one(db, `INSERT INTO business_projects (business_id, name, description, owner_user_id, status, start_on, end_on, location_id, outlet_id, template_code, created_by, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING id`,
    [scope.businessId, data.name, data.description ?? template?.description ?? null, ownerId, status, startOn, endOn, place.locationId, place.outletId, template?.code || null, scope.userId]);
    const memberIds = (body.memberIds ? v.requiredArray(body.memberIds, "Members") : []).map((m) => id(m, "Member"));
    if (memberIds.length > 100) fail(400, "100 members at most");
    await addMembers(db, scope, row.id, memberIds, ownerId);
    if (template) {
      let position = 0;
      for (const [name, days] of template.milestones) {
        await db.query("INSERT INTO business_project_milestones (business_id, project_id, name, due_on, position) VALUES ($1, $2, $3, $4, $5)",
          [scope.businessId, row.id, name, addDays(startOn, days), position++]);
      }
      position = 0;
      const tasks = require("./tasks.service");
      for (const [listName, titles] of Object.entries(template.lists)) {
        const list = await repo.one(db, "INSERT INTO business_project_lists (business_id, project_id, name, position) VALUES ($1, $2, $3, $4) RETURNING id",
          [scope.businessId, row.id, listName, position++]);
        for (const title of titles) {
          await tasks.createIn(db, { ...scope, can: (perm) => perm === "tasks.assign" || scope.can(perm) }, {
            title, category: template.category, projectId: row.id, projectListId: list.id,
            assignMode: "people", assignees: [{ kind: "user", id: ownerId }], placeId: place.outletId || place.locationId || undefined,
          });
        }
      }
    }
    await repo.history(db, scope, { projectId: row.id }, "created", { name: data.name, template: template?.name || null });
    await repo.audit(db, scope, "project.created", row.id, { name: data.name, template: template?.code || null });
    return row.id;
  });
  return detail(scope, projectId);
}

async function update(scope, projectId, body) {
  await repo.transaction(async (db) => {
    const row = await load(db, scope, projectId, { lock: true });
    if (!canEdit(scope, row)) fail(403, "Only the project's owner (or someone who can change any project) can change it");
    const data = readProject(body, true);
    const set = [], values = [scope.businessId, row.id];
    const put = (column, value) => { values.push(value); set.push(`${column} = $${values.length}`); };
    if (data.name !== undefined) put("name", data.name);
    if (data.description !== undefined) put("description", data.description);
    if (data.startOn !== undefined) put("start_on", data.startOn);
    if (data.endOn !== undefined) put("end_on", data.endOn);
    if (body.status !== undefined) {
      const status = v.requiredEnum(body.status, "Status", PROJECT_STATUSES);
      put("status", status);
      put("completed_at", status === "completed" ? row.completed_at || new Date().toISOString() : null);
      data.status = status;
    }
    if (body.ownerId !== undefined) {
      if (!scope.can("projects.manage")) fail(403, "Only someone who can change any project can hand it to another owner");
      const ownerId = id(body.ownerId, "Owner");
      await people.requireUser(db, scope, ownerId, "Owner");
      put("owner_user_id", ownerId);
      await db.query("UPDATE business_project_members SET role = 'member' WHERE business_id = $1 AND project_id = $2 AND role = 'owner'", [scope.businessId, row.id]);
      await addMembers(db, scope, row.id, [], ownerId);
      data.ownerId = ownerId;
    }
    if (body.placeId !== undefined) {
      const place = await people.readPlace(db, scope, body);
      put("outlet_id", place.outletId);
      put("location_id", place.locationId);
    }
    if (!set.length) return;
    const startOn = data.startOn !== undefined ? data.startOn : row.start_on;
    const endOn = data.endOn !== undefined ? data.endOn : row.end_on;
    if (startOn && endOn && endOn < startOn) fail(400, "The project ends before it starts");
    await db.query(`UPDATE business_projects SET ${set.join(", ")}, updated_by = $${values.length + 1}, updated_at = now() WHERE business_id = $1 AND id = $2`, [...values, scope.userId]);
    await repo.history(db, scope, { projectId: row.id }, data.status ? `status_${data.status}` : "updated", data);
    await repo.audit(db, scope, "project.updated", row.id, data);
  });
  return detail(scope, projectId);
}

async function setMembers(scope, projectId, body) {
  const userIds = v.requiredArray(body.memberIds, "Members").map((m) => id(m, "Member"));
  if (userIds.length > 100) fail(400, "100 members at most");
  await repo.transaction(async (db) => {
    const row = await load(db, scope, projectId, { lock: true });
    if (!canEdit(scope, row)) fail(403, "Only the project's owner can change its members");
    await db.query("DELETE FROM business_project_members WHERE business_id = $1 AND project_id = $2 AND user_id <> ALL($3::bigint[]) AND role <> 'owner'", [scope.businessId, row.id, userIds]);
    await addMembers(db, scope, row.id, userIds, Number(row.owner_user_id));
    await repo.history(db, scope, { projectId: row.id }, "members", { count: userIds.length });
  });
  return detail(scope, projectId);
}

async function saveMilestone(scope, projectId, milestoneId, body) {
  await repo.transaction(async (db) => {
    const row = await load(db, scope, projectId, { lock: true });
    const member = Boolean(row.member);
    if (!canEdit(scope, row) && !(member && body.done !== undefined && Object.keys(body).length === 1)) fail(403, "Only the project's owner can change milestones");
    if (milestoneId) {
      const ms = await repo.one(db, "SELECT * FROM business_project_milestones WHERE business_id = $1 AND project_id = $2 AND id = $3", [scope.businessId, row.id, id(milestoneId, "Milestone")]);
      if (!ms) fail(404, "Milestone not found");
      if (body.done !== undefined) {
        const done = v.requiredBoolean(body.done, "Done");
        await db.query("UPDATE business_project_milestones SET done_at = CASE WHEN $3 THEN now() END, done_by = CASE WHEN $3 THEN $4::bigint END WHERE business_id = $1 AND id = $2",
          [scope.businessId, ms.id, done, scope.userId]);
        await repo.history(db, scope, { projectId: row.id }, done ? "milestone_done" : "milestone_reopened", { name: ms.name });
      }
      if (body.name !== undefined || body.dueOn !== undefined) {
        await db.query("UPDATE business_project_milestones SET name = $3, due_on = $4 WHERE business_id = $1 AND id = $2",
          [scope.businessId, ms.id, body.name !== undefined ? v.requiredString(body.name, "Milestone", 120) : ms.name, body.dueOn !== undefined ? dateText(body.dueOn, "Due") : ms.due_on]);
        await repo.history(db, scope, { projectId: row.id }, "milestone_changed", { name: body.name || ms.name });
      }
    } else {
      const name = v.requiredString(body.name, "Milestone", 120);
      const position = Number((await repo.one(db, "SELECT COALESCE(max(position), -1) + 1 AS n FROM business_project_milestones WHERE business_id = $1 AND project_id = $2", [scope.businessId, row.id])).n);
      await db.query("INSERT INTO business_project_milestones (business_id, project_id, name, due_on, position) VALUES ($1, $2, $3, $4, $5)",
        [scope.businessId, row.id, name, dateText(body.dueOn, "Due"), position]);
      await repo.history(db, scope, { projectId: row.id }, "milestone_added", { name });
    }
  });
  return detail(scope, projectId);
}

async function removeMilestone(scope, projectId, milestoneId) {
  await repo.transaction(async (db) => {
    const row = await load(db, scope, projectId, { lock: true });
    if (!canEdit(scope, row)) fail(403, "Only the project's owner can change milestones");
    const ms = await repo.one(db, "DELETE FROM business_project_milestones WHERE business_id = $1 AND project_id = $2 AND id = $3 RETURNING name", [scope.businessId, row.id, id(milestoneId, "Milestone")]);
    if (!ms) fail(404, "Milestone not found");
    await repo.history(db, scope, { projectId: row.id }, "milestone_removed", { name: ms.name });
  });
  return detail(scope, projectId);
}

async function addList(scope, projectId, body) {
  await repo.transaction(async (db) => {
    const row = await load(db, scope, projectId, { lock: true });
    if (!canEdit(scope, row)) fail(403, "Only the project's owner can change task lists");
    const name = v.requiredString(body.name, "List name", 80);
    const position = Number((await repo.one(db, "SELECT COALESCE(max(position), -1) + 1 AS n FROM business_project_lists WHERE business_id = $1 AND project_id = $2", [scope.businessId, row.id])).n);
    await db.query("INSERT INTO business_project_lists (business_id, project_id, name, position) VALUES ($1, $2, $3, $4)", [scope.businessId, row.id, name, position]);
    await repo.history(db, scope, { projectId: row.id }, "list_added", { name });
  });
  return detail(scope, projectId);
}

async function removeList(scope, projectId, listId) {
  await repo.transaction(async (db) => {
    const row = await load(db, scope, projectId, { lock: true });
    if (!canEdit(scope, row)) fail(403, "Only the project's owner can change task lists");
    // Its tasks stay in the project, outside any list (ON DELETE SET NULL).
    const list = await repo.one(db, "DELETE FROM business_project_lists WHERE business_id = $1 AND project_id = $2 AND id = $3 RETURNING name", [scope.businessId, row.id, id(listId, "Task list")]);
    if (!list) fail(404, "Task list not found");
    await repo.history(db, scope, { projectId: row.id }, "list_removed", { name: list.name });
  });
  return detail(scope, projectId);
}

async function comment(scope, projectId, body) {
  const text = v.requiredString(body.body, "Comment", 2000);
  const tasks = require("./tasks.service");
  await repo.transaction(async (db) => {
    const row = await load(db, scope, projectId);
    await db.query("INSERT INTO business_task_comments (business_id, project_id, body, created_by) VALUES ($1, $2, $3, $4)", [scope.businessId, row.id, text, scope.userId]);
  });
  return tasks.commentsOf(repo.pool, scope, { projectId: id(projectId, "Project") });
}

const templatesList = () => library.PROJECT_TEMPLATES.map((t) => ({
  code: t.code, name: t.name, description: t.description || null, category: t.category, days: t.days,
  milestones: t.milestones.map(([name, days]) => ({ name, days })),
  lists: Object.entries(t.lists).map(([name, tasks]) => ({ name, tasks })),
  taskCount: Object.values(t.lists).reduce((n, list) => n + list.length, 0),
}));

module.exports = { list, detail, create, update, setMembers, saveMilestone, removeMilestone, addList, removeList, comment, templatesList };
