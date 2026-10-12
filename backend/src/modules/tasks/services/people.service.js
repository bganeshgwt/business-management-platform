const repo = require("../repositories/tasks.repository");
const { fail, id, optionalId, v, ASSIGN_MODES } = require("./common");

// Who and where, in either world.
//
//   restaurant: users (logins), employees (staff records; one with a login is
//               the same person as that user), restaurant roles, outlets, shifts
//   business:   members (logins), resources (stylists, doctors, rooms…),
//               business roles, locations

// What the screens need first: roles, places and shifts of this business.
// People are not listed here: the pickers search them on the server
// (search below); peopleCount says how many there are.
async function directory(scope) {
  if (scope.world === "restaurant") {
    const [count, roles, places, shifts] = await Promise.all([
      repo.one(repo.pool, `SELECT (SELECT count(*) FROM users WHERE restaurant_id = $1 AND status = 'active')
          + (SELECT count(*) FROM employees WHERE restaurant_id = $1 AND status = 'active' AND user_id IS NULL) AS n`, [scope.restaurantId]),
      repo.all(repo.pool, `SELECT id, name FROM roles WHERE status = 'active' AND ((restaurant_id IS NULL AND is_system AND code NOT IN ('SUPER_ADMIN', 'DISPLAY')) OR restaurant_id = $1)
        ORDER BY restaurant_id NULLS FIRST, name`, [scope.restaurantId]),
      repo.all(repo.pool, "SELECT id, name FROM outlets WHERE restaurant_id = $1 AND status = 'active' ORDER BY name", [scope.restaurantId]),
      repo.all(repo.pool, `SELECT id, name, outlet_id, start_time::text AS start_time, end_time::text AS end_time FROM shifts
        WHERE restaurant_id = $1 AND status = 'active' ORDER BY start_time`, [scope.restaurantId]),
    ]);
    return {
      world: "restaurant",
      peopleCount: Number(count.n),
      roles: roles.map((r) => ({ kind: "role", id: Number(r.id), name: r.name })),
      places: places.map((p) => ({ id: Number(p.id), name: p.name })),
      placeWord: "Outlet",
      shifts: shifts.map((s) => ({ id: Number(s.id), name: s.name, placeId: s.outlet_id ? Number(s.outlet_id) : null, start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5) })),
      outletScope: scope.outletScope,
    };
  }
  const [count, roles, places] = await Promise.all([
    repo.one(repo.pool, `SELECT (SELECT count(*) FROM business_memberships WHERE business_id = $1 AND active)
        + (SELECT count(*) FROM business_resources WHERE business_id = $1 AND active) AS n`, [scope.businessId]),
    repo.all(repo.pool, "SELECT id, name FROM business_roles WHERE business_id = $1 AND active ORDER BY full_access DESC, name", [scope.businessId]),
    repo.all(repo.pool, "SELECT id, name FROM business_locations WHERE business_id = $1 AND active ORDER BY id", [scope.businessId]),
  ]);
  return {
    world: "business",
    peopleCount: Number(count.n),
    roles: roles.map((r) => ({ kind: "business_role", id: Number(r.id), name: r.name })),
    places: places.map((p) => ({ id: Number(p.id), name: p.name })),
    placeWord: "Location",
    shifts: [],
    outletScope: null,
  };
}

// The people pickers search on the server (round 2, R2-WS): a big restaurant
// has hundreds of logins and staff, and loading them all with the screen
// cost about 330 KB. query: { q?, kind? ('user' = logins only), limit?, offset? }
// → { rows: [{ kind, id, name, detail, placeId, login }], total }, by name.
async function search(scope, query = {}) {
  const text = typeof query.q === "string" && query.q.trim() ? `%${query.q.trim().slice(0, 60).replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const loginsOnly = query.kind === "user";
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0 || offset > 100000) fail(400, "Invalid pagination");
  let sql;
  if (scope.world === "restaurant") {
    sql = `WITH people AS (
        SELECT 'user' AS kind, u.id, u.name, u.outlet_id AS place_id, TRUE AS login,
          COALESCE(e.designation, NULLIF((SELECT string_agg(r.name, ', ' ORDER BY r.name) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '')) AS detail
        FROM users u LEFT JOIN employees e ON e.user_id = u.id AND e.restaurant_id = u.restaurant_id AND e.status = 'active'
        WHERE u.restaurant_id = $1 AND u.status = 'active'
        UNION ALL
        SELECT 'employee', e.id, e.name, e.outlet_id, FALSE, COALESCE(e.designation, 'Staff (no login)')
        FROM employees e WHERE e.restaurant_id = $1 AND e.status = 'active' AND e.user_id IS NULL AND NOT $3)`;
  } else {
    sql = `WITH people AS (
        SELECT 'user' AS kind, u.id, u.name, NULL::bigint AS place_id, TRUE AS login, r.name AS detail
        FROM business_memberships m JOIN users u ON u.id = m.user_id JOIN business_roles r ON r.business_id = m.business_id AND r.id = m.role_id
        WHERE m.business_id = $1 AND m.active
        UNION ALL
        SELECT 'resource', x.id, x.name, x.location_id, FALSE, COALESCE(x.role_label, 'No login')
        FROM business_resources x WHERE x.business_id = $1 AND x.active AND NOT $3)`;
  }
  const row = await repo.one(repo.pool, `${sql},
      matched AS (SELECT * FROM people WHERE $2::text IS NULL OR name ILIKE $2 OR detail ILIKE $2)
    SELECT (SELECT count(*)::int FROM matched) AS total,
      COALESCE((SELECT json_agg(p) FROM (SELECT * FROM matched ORDER BY lower(name), kind, id LIMIT $4 OFFSET $5) p), '[]') AS rows`,
  [scope.world === "restaurant" ? scope.restaurantId : scope.businessId, text, loginsOnly, limit, offset]);
  return {
    total: row.total,
    rows: row.rows.map((p) => ({ kind: p.kind, id: Number(p.id), name: p.name, detail: p.detail || (p.login ? null : "No login"), placeId: p.place_id ? Number(p.place_id) : null, login: p.login })),
  };
}

// The place a record is at: { outletId } at a restaurant, { locationId }
// elsewhere. Someone tied to one outlet works at that outlet.
async function readPlace(db, scope, body) {
  const placeId = optionalId(body.placeId ?? body.outletId ?? body.locationId, scope.world === "restaurant" ? "Outlet" : "Location");
  if (scope.world === "restaurant") {
    const outletId = scope.outletScope && !placeId ? scope.outletScope : placeId;
    if (scope.outletScope && outletId !== scope.outletScope) fail(403, "You are set up to work at one outlet only.");
    if (outletId && !(await repo.one(db, "SELECT 1 FROM outlets WHERE id = $1 AND restaurant_id = $2", [outletId, scope.restaurantId]))) fail(400, "Outlet not found");
    return { outletId: outletId || null, locationId: null };
  }
  if (placeId && !(await repo.one(db, "SELECT 1 FROM business_locations WHERE business_id = $1 AND id = $2", [scope.businessId, placeId]))) fail(400, "Location not found");
  return { outletId: null, locationId: placeId || null };
}

// A user who works in this business (a restaurant login, or a member).
async function requireUser(db, scope, userId, name = "Person") {
  const uid = id(userId, name);
  const found = scope.world === "restaurant"
    ? await repo.one(db, "SELECT id, name FROM users WHERE id = $1 AND restaurant_id = $2 AND status = 'active'", [uid, scope.restaurantId])
    : await repo.one(db, "SELECT u.id, u.name FROM business_memberships m JOIN users u ON u.id = m.user_id WHERE m.business_id = $1 AND m.user_id = $2 AND m.active", [scope.businessId, uid]);
  if (!found) fail(400, `${name} does not work in this business`);
  return found;
}

const KINDS = { restaurant: ["user", "employee", "role"], business: ["user", "resource", "business_role"] };

// assignMode + [{ kind, id }] → the rows to store. Checked against this business.
async function readAssignees(db, scope, modeValue, list) {
  const mode = v.optionalEnum(modeValue, "Assign to", ASSIGN_MODES, "people");
  const entries = list === undefined || list === null ? [] : v.requiredArray(list, "Assignees");
  if (entries.length > 50) fail(400, "Assign to 50 people at most");
  const rows = [];
  const seen = new Set();
  for (const entry of entries) {
    const kind = v.requiredEnum(entry && entry.kind, "Assignee kind", KINDS[scope.world]);
    const key = `${kind}:${id(entry.id, "Assignee")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ kind, id: Number(entry.id) });
  }
  const people = rows.filter((r) => !["role", "business_role"].includes(r.kind));
  const roles = rows.filter((r) => ["role", "business_role"].includes(r.kind));
  if (mode === "people" && (!people.length || roles.length)) fail(400, "Choose at least one person");
  if (mode === "role" && (roles.length !== 1 || people.length)) fail(400, "Choose one role");
  if (["on_shift", "unassigned"].includes(mode) && rows.length) fail(400, "Whoever is on shift / unassigned names nobody");
  for (const row of rows) {
    const ok = {
      user: () => requireUser(db, scope, row.id, "Assignee").then(Boolean),
      employee: () => repo.one(db, "SELECT 1 FROM employees WHERE id = $1 AND restaurant_id = $2 AND status = 'active'", [row.id, scope.restaurantId]),
      resource: () => repo.one(db, "SELECT 1 FROM business_resources WHERE business_id = $1 AND id = $2 AND active", [scope.businessId, row.id]),
      role: () => repo.one(db, "SELECT 1 FROM roles WHERE id = $1 AND status = 'active' AND (restaurant_id = $2 OR (restaurant_id IS NULL AND is_system))", [row.id, scope.restaurantId]),
      business_role: () => repo.one(db, "SELECT 1 FROM business_roles WHERE business_id = $1 AND id = $2 AND active", [scope.businessId, row.id]),
    }[row.kind];
    if (!(await ok())) fail(400, "An assignee is not part of this business");
  }
  return { mode, rows };
}

const COLUMN = { user: "user_id", employee: "employee_id", resource: "resource_id", role: "role_id", business_role: "business_role_id" };

async function saveAssignees(db, scope, owner, rows) {
  const column = owner.taskId ? "task_id" : "schedule_id";
  const ownerId = owner.taskId || owner.scheduleId;
  await db.query(`DELETE FROM business_task_assignees WHERE business_id = $1 AND ${column} = $2`, [scope.businessId, ownerId]);
  for (const row of rows) {
    await db.query(`INSERT INTO business_task_assignees (business_id, ${column}, kind, ${COLUMN[row.kind]}) VALUES ($1, $2, $3, $4)`,
      [scope.businessId, ownerId, row.kind, row.id]);
  }
}

// Only the signed-in person (as a user, or the staff record linked to them).
const isOnlySelf = (scope, mode, rows) => mode === "people" && rows.length > 0
  && rows.every((r) => (r.kind === "user" && r.id === scope.userId) || (r.kind === "employee" && scope.employeeIds.includes(r.id)));

// --- Whose task is it? (SQL) ---------------------------------------------------

// "Assigned to me": a listed person, my staff record, a role I hold, or
// whoever is on shift (at a restaurant: rostered or clocked in that day, or
// everyone when nobody is rostered that day; elsewhere: every member).
function mineSql(scope, p, t = "t") {
  const uid = p.add(scope.userId);
  const people = [`a.user_id = ${uid}`];
  if (scope.employeeIds.length) people.push(`a.employee_id = ANY(${p.add(scope.employeeIds)}::bigint[])`);
  if (scope.roleIds.length) people.push(`a.role_id = ANY(${p.add(scope.roleIds)}::bigint[])`);
  if (scope.businessRoleId) people.push(`a.business_role_id = ${p.add(scope.businessRoleId)}`);
  const listed = `EXISTS (SELECT 1 FROM business_task_assignees a WHERE a.business_id = ${t}.business_id AND a.task_id = ${t}.id AND (${people.join(" OR ")}))`;
  let onShift;
  if (scope.world === "restaurant") {
    const day = `COALESCE(${t}.occurrence_date, (COALESCE(${t}.due_at, ${t}.created_at) AT TIME ZONE ${p.add(scope.timezone)})::date)`;
    const rid = p.add(scope.restaurantId);
    const emp = p.add(scope.employeeIds);
    const pinned = scope.outletScope ? `(${t}.outlet_id IS NULL OR ${t}.outlet_id = ${p.add(scope.outletScope)})` : "TRUE";
    onShift = `(${t}.assign_mode = 'on_shift' AND ${pinned} AND (
      EXISTS (SELECT 1 FROM shift_assignments sa JOIN shifts s ON s.id = sa.shift_id WHERE sa.restaurant_id = ${rid} AND sa.employee_id = ANY(${emp}::bigint[])
        AND sa.work_date = ${day} AND sa.assignment_status = 'scheduled' AND (${t}.outlet_id IS NULL OR s.outlet_id IS NULL OR s.outlet_id = ${t}.outlet_id))
      OR EXISTS (SELECT 1 FROM attendance at WHERE at.restaurant_id = ${rid} AND at.employee_id = ANY(${emp}::bigint[]) AND at.attendance_date = ${day} AND at.check_in IS NOT NULL)
      OR NOT EXISTS (SELECT 1 FROM shift_assignments sa WHERE sa.restaurant_id = ${rid} AND sa.work_date = ${day} AND sa.assignment_status = 'scheduled')))`;
  } else {
    onShift = `${t}.assign_mode = 'on_shift'`;
  }
  return `((${t}.assign_mode IN ('people', 'role') AND ${listed}) OR ${onShift} OR ${t}.started_by = ${uid})`;
}

// What this person may see of tasks: everything (tasks.view, within their
// outlet), else their own, what they created or did, and their projects' tasks.
function visibleSql(scope, p, t = "t") {
  const outlet = scope.outletScope ? `(${t}.outlet_id IS NULL OR ${t}.outlet_id = ${p.add(scope.outletScope)})` : "TRUE";
  if (scope.can("tasks.view")) return outlet;
  const uid = p.add(scope.userId);
  return `(${outlet} AND (${mineSql(scope, p, t)} OR ${t}.created_by = ${uid} OR ${t}.completed_by = ${uid}
    OR (${t}.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM business_project_members pm WHERE pm.business_id = ${t}.business_id AND pm.project_id = ${t}.project_id AND pm.user_id = ${uid}))))`;
}

// Names of a task's assignees, for lists: "Ravi, Priya" / "Role: Manager" / "Whoever is on shift".
const assigneeNamesSql = (t = "t") => `CASE ${t}.assign_mode
  WHEN 'on_shift' THEN 'Whoever is on shift'
  WHEN 'unassigned' THEN 'Not assigned'
  ELSE COALESCE((SELECT string_agg(COALESCE(u.name, e.name, r.name, ro.name, br.name), ', ' ORDER BY a.id)
    FROM business_task_assignees a
    LEFT JOIN users u ON u.id = a.user_id LEFT JOIN employees e ON e.id = a.employee_id
    LEFT JOIN business_resources r ON r.business_id = a.business_id AND r.id = a.resource_id
    LEFT JOIN roles ro ON ro.id = a.role_id LEFT JOIN business_roles br ON br.business_id = a.business_id AND br.id = a.business_role_id
    WHERE a.business_id = ${t}.business_id AND a.task_id = ${t}.id), 'Not assigned') END`;

const placeNameSql = (t = "t") => `COALESCE((SELECT name FROM outlets o WHERE o.id = ${t}.outlet_id), (SELECT name FROM business_locations l WHERE l.business_id = ${t}.business_id AND l.id = ${t}.location_id))`;

module.exports = { directory, search, readPlace, requireUser, readAssignees, saveAssignees, isOnlySelf, mineSql, visibleSql, assigneeNamesSql, placeNameSql };
