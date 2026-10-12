const repo = require("../repositories/tasks.repository");
const library = require("../library");
const { fail, id, v, category, ITEM_KINDS, PRIORITIES, SEVERITIES, search } = require("./common");

// The template library (built in, read-only) and the business's own templates.

const ITEM_COLUMNS = ["position", "kind", "label", "help", "required", "unit", "min_value", "max_value", "options", "expected",
  "photo_required", "critical", "raise_issue", "fail_severity"];

// One checklist item from the browser (camelCase or snake_case), checked.
function readItem(raw, position) {
  if (!raw || typeof raw !== "object") fail(400, "Each checklist item must be an object");
  const kind = v.requiredEnum(raw.kind, "Item kind", ITEM_KINDS);
  const label = v.requiredString(raw.label, `Item ${position + 1}`, 200);
  const num = (value, name) => (value === undefined || value === null || value === "" ? null : v.requiredNumber(value, name, { min: -1e8, max: 1e8 }));
  const item = {
    position, kind, label,
    help: v.optionalString(raw.help, "Help text", 500),
    required: kind === "section" ? false : v.requiredBoolean(raw.required, "Required", true),
    unit: kind === "number" ? v.optionalString(raw.unit, "Unit", 20) : null,
    min_value: kind === "number" ? num(raw.minValue ?? raw.min_value, `Lowest allowed (${label})`) : null,
    max_value: kind === "number" ? num(raw.maxValue ?? raw.max_value, `Highest allowed (${label})`) : null,
    options: null,
    expected: kind === "yes_no" ? v.optionalEnum(raw.expected, "Passing answer", ["yes", "no"], "yes") : null,
    photo_required: kind === "section" ? false : v.requiredBoolean(raw.photoRequired ?? raw.photo_required, "Photo needed", false),
    critical: ["yes_no", "number", "choice"].includes(kind) ? v.requiredBoolean(raw.critical, "Critical", false) : false,
    raise_issue: ["yes_no", "number", "choice"].includes(kind) ? v.requiredBoolean(raw.raiseIssue ?? raw.raise_issue, "Raise an issue", true) : false,
    fail_severity: v.optionalEnum(raw.failSeverity ?? raw.fail_severity, "Issue severity", SEVERITIES, "medium"),
  };
  if (item.min_value !== null && item.max_value !== null && item.min_value > item.max_value) fail(400, `${label}: the lowest allowed is above the highest`);
  if (kind === "choice") {
    const options = v.requiredArray(raw.options, `${label}: choices`);
    if (options.length < 2 || options.length > 12) fail(400, `${label}: give 2 to 12 choices`);
    item.options = options.map((o) => ({
      label: v.requiredString(typeof o === "string" ? o : o && o.label, `${label}: choice`, 60),
      fail: typeof o === "object" && o !== null ? Boolean(o.fail) : false,
    }));
    if (new Set(item.options.map((o) => o.label.toLowerCase())).size !== item.options.length) fail(400, `${label}: two choices have the same name`);
  }
  return item;
}

function readItems(list) {
  const raw = list === undefined || list === null ? [] : v.requiredArray(list, "Checklist items");
  if (raw.length > 200) fail(400, "A checklist can have 200 items at most");
  return raw.map((item, index) => readItem(item, index));
}

// Inserts checklist items (template or task) in one statement.
async function insertItems(db, table, businessId, ownerColumn, ownerId, items) {
  if (!items.length) return;
  const json = JSON.stringify(items.map((item, index) => ({ ...item, position: index, options: item.options || null })));
  await db.query(
    `INSERT INTO ${table} (business_id, ${ownerColumn}, ${ITEM_COLUMNS.join(", ")})
     SELECT $1, $2, ${ITEM_COLUMNS.join(", ")} FROM jsonb_to_recordset($3::jsonb) AS x(
       position smallint, kind text, label text, help text, required boolean, unit text, min_value numeric, max_value numeric,
       options jsonb, expected text, photo_required boolean, critical boolean, raise_issue boolean, fail_severity text)`,
    [businessId, ownerId, json]
  );
}

const shapeLibrary = (t, withItems = false) => ({
  code: t.code, name: t.name, description: t.description, category: t.category, priority: t.priority,
  requiresReview: t.requiresReview, estimatedMinutes: t.estimatedMinutes, common: t.common, suggested: t.suggested,
  itemCount: t.items.filter((i) => i.kind !== "section").length,
  ...(withItems ? { items: t.items } : {}),
  source: "library",
});

function libraryList(scope, query = {}) {
  const q = search(query.q)?.toLowerCase();
  const cat = query.category ? category(query.category) : null;
  return library.forType(scope.businessType)
    .filter((t) => (!cat || t.category === cat) && (!q || `${t.name} ${t.description || ""}`.toLowerCase().includes(q)))
    .map((t) => shapeLibrary(t));
}

function libraryOne(scope, code) {
  const t = library.get(String(code || ""));
  if (!t || !t.types.includes(scope.businessType)) fail(404, "Template not found");
  return shapeLibrary(t, true);
}

const shapeOwn = (row, items) => ({
  id: Number(row.id), name: row.name, description: row.description, category: row.category_code, priority: row.priority,
  requiresReview: row.requires_review, estimatedMinutes: row.estimated_minutes, libraryCode: row.library_code, active: row.active,
  itemCount: Number(row.item_count ?? (items ? items.filter((i) => i.kind !== "section").length : 0)),
  updatedAt: row.updated_at, updatedByName: row.updated_by_name || null,
  usedBy: Number(row.used_by || 0),
  ...(items ? { items: items.map(shapeItem) } : {}),
  source: "own",
});

const shapeItem = (i) => ({
  id: i.id ? Number(i.id) : undefined, position: Number(i.position), kind: i.kind, label: i.label, help: i.help, required: i.required,
  unit: i.unit, minValue: i.min_value === null ? null : Number(i.min_value), maxValue: i.max_value === null ? null : Number(i.max_value),
  options: i.options, expected: i.expected, photoRequired: i.photo_required, critical: i.critical, raiseIssue: i.raise_issue, failSeverity: i.fail_severity,
});

async function ownList(scope, query = {}) {
  const q = search(query.q);
  const rows = await repo.all(repo.pool, `SELECT t.*, u.name AS updated_by_name,
      (SELECT count(*) FROM business_task_template_items i WHERE i.business_id = t.business_id AND i.template_id = t.id AND i.kind <> 'section') AS item_count,
      (SELECT count(*) FROM business_task_schedules s WHERE s.business_id = t.business_id AND s.template_id = t.id AND s.active) AS used_by
    FROM business_task_templates t LEFT JOIN users u ON u.id = t.updated_by
    WHERE t.business_id = $1 AND ($2::text IS NULL OR t.name ILIKE '%' || $2 || '%') AND ($3::boolean OR t.active)
    ORDER BY t.active DESC, t.name LIMIT 500`, [scope.businessId, q, query.all === "1" || query.all === "true"]);
  return rows.map((r) => shapeOwn(r));
}

async function loadOwn(db, scope, templateId) {
  const row = await repo.one(db, "SELECT * FROM business_task_templates WHERE business_id = $1 AND id = $2", [scope.businessId, id(templateId, "Template")]);
  if (!row) fail(404, "Template not found");
  const items = await repo.all(db, "SELECT * FROM business_task_template_items WHERE business_id = $1 AND template_id = $2 ORDER BY position", [scope.businessId, row.id]);
  return { row, items };
}

async function ownOne(scope, templateId) {
  const { row, items } = await loadOwn(repo.pool, scope, templateId);
  return shapeOwn(row, items);
}

function readTemplate(body) {
  return {
    name: v.requiredString(body.name, "Template name", 120),
    description: v.optionalString(body.description, "Description", 1000),
    category: category(body.category),
    priority: v.optionalEnum(body.priority, "Priority", PRIORITIES, "normal"),
    requiresReview: v.requiredBoolean(body.requiresReview, "Needs review", false),
    estimatedMinutes: body.estimatedMinutes === undefined || body.estimatedMinutes === null || body.estimatedMinutes === ""
      ? null : v.requiredNumber(body.estimatedMinutes, "Minutes it takes", { min: 1, max: 1440 }),
    items: readItems(body.items),
  };
}

async function create(scope, body) {
  await scope.require("tasks.manage");
  const t = readTemplate(body);
  if (!t.items.some((i) => i.kind !== "section")) fail(400, "Add at least one checklist item");
  return repo.transaction(async (db) => {
    const row = await repo.one(db, `INSERT INTO business_task_templates (business_id, name, description, category_code, priority, requires_review, estimated_minutes, library_code, created_by, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING *`,
    [scope.businessId, t.name, t.description, t.category, t.priority, t.requiresReview, t.estimatedMinutes, body.libraryCode ? String(body.libraryCode).slice(0, 80) : null, scope.userId]);
    await insertItems(db, "business_task_template_items", scope.businessId, "template_id", row.id, t.items);
    await repo.audit(db, scope, "task_template.created", row.id, { name: t.name, items: t.items.length });
    return shapeOwn(row, t.items);
  });
}

async function update(scope, templateId, body) {
  await scope.require("tasks.manage");
  const t = readTemplate(body);
  if (!t.items.some((i) => i.kind !== "section")) fail(400, "Add at least one checklist item");
  return repo.transaction(async (db) => {
    const { row } = await loadOwn(db, scope, templateId);
    const active = v.requiredBoolean(body.active, "Active", row.active);
    const saved = await repo.one(db, `UPDATE business_task_templates SET name = $3, description = $4, category_code = $5, priority = $6,
      requires_review = $7, estimated_minutes = $8, active = $9, updated_by = $10, updated_at = now() WHERE business_id = $1 AND id = $2 RETURNING *`,
    [scope.businessId, row.id, t.name, t.description, t.category, t.priority, t.requiresReview, t.estimatedMinutes, active, scope.userId]);
    // Tasks keep their own copy of the items, so replacing them changes no checklist already made.
    await db.query("DELETE FROM business_task_template_items WHERE business_id = $1 AND template_id = $2", [scope.businessId, row.id]);
    await insertItems(db, "business_task_template_items", scope.businessId, "template_id", row.id, t.items);
    await repo.audit(db, scope, "task_template.updated", row.id, { name: t.name, items: t.items.length, active });
    return shapeOwn(saved, t.items);
  });
}

async function setActive(scope, templateId, body) {
  await scope.require("tasks.manage");
  const active = v.requiredBoolean(body.active, "Active");
  return repo.transaction(async (db) => {
    const { row } = await loadOwn(db, scope, templateId);
    await db.query("UPDATE business_task_templates SET active = $3, updated_by = $4, updated_at = now() WHERE business_id = $1 AND id = $2", [scope.businessId, row.id, active, scope.userId]);
    await repo.audit(db, scope, active ? "task_template.restored" : "task_template.archived", row.id, { name: row.name });
    return { id: Number(row.id), active };
  });
}

// "Copy and edit": a built-in or own template becomes a new own template.
async function copy(scope, body) {
  await scope.require("tasks.manage");
  if (body.libraryCode) {
    const t = libraryOne(scope, body.libraryCode);
    return create(scope, { name: v.optionalString(body.name, "Template name", 120) || t.name, description: t.description, category: t.category,
      priority: t.priority, requiresReview: t.requiresReview, estimatedMinutes: t.estimatedMinutes, items: t.items, libraryCode: t.code });
  }
  const source = await ownOne(scope, body.templateId);
  return create(scope, { ...source, name: v.optionalString(body.name, "Template name", 120) || `${source.name} (copy)`, items: source.items, libraryCode: source.libraryCode });
}

// The template a task or schedule is made from: { name, category, items, … }.
async function resolve(db, scope, { templateId, libraryCode, allowArchived = false }) {
  if (templateId) {
    const { row, items } = await loadOwn(db, scope, templateId);
    if (!row.active && !allowArchived) fail(409, "That template is archived");
    return { templateId: Number(row.id), libraryCode: null, name: row.name, description: row.description, category: row.category_code,
      priority: row.priority, requiresReview: row.requires_review, items };
  }
  if (libraryCode) {
    const t = libraryOne(scope, libraryCode);
    return { templateId: null, libraryCode: t.code, name: t.name, description: t.description, category: t.category, priority: t.priority,
      requiresReview: t.requiresReview, items: t.items };
  }
  return null;
}

module.exports = { libraryList, libraryOne, ownList, ownOne, create, update, setActive, copy, resolve, readItems, insertItems, shapeItem };
