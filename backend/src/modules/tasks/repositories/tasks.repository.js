const pool = require("../../../config/database");

// The tasks module's database helpers. Everything here takes `db`: the pool
// for a single read, or the transaction's own client inside a transaction —
// never the pool while a transaction is open (DB_POOL_GUARD).

async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const one = async (db, sql, values = []) => (await db.query(sql, values)).rows[0] || null;
const all = async (db, sql, values = []) => (await db.query(sql, values)).rows;

// The trail on a task, issue or project (append-only), and the business's
// activity log, both inside the caller's transaction.
async function history(db, scope, target, action, details = {}) {
  await db.query(
    `INSERT INTO business_task_history (business_id, task_id, issue_id, project_id, action, details, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [scope.businessId, target.taskId || null, target.issueId || null, target.projectId || null, action, JSON.stringify(details), scope.userId]
  );
}

async function audit(db, scope, action, entityId, details = {}) {
  await db.query("INSERT INTO business_audit (business_id, actor_id, action, entity_id, details) VALUES ($1, $2, $3, $4, $5)",
    [scope.businessId, scope.userId, action, entityId, JSON.stringify(details)]);
  if (scope.world === "restaurant") await restaurantAudit(db, scope, action, entityId, details);
}

// A restaurant reads its activity log from audit_logs: the
// same action is written there too, in that log's shape ("task.completed" →
// action "completed", entity "task", labelled with the task's title), inside
// the same transaction. A savepoint keeps a failure here from undoing the
// action itself, as the restaurant's own audit writer does.
const LABELS = {
  task: "SELECT title AS label FROM business_tasks WHERE business_id = $1 AND id = $2",
  issue: "SELECT title AS label FROM business_issues WHERE business_id = $1 AND id = $2",
  project: "SELECT name AS label FROM business_projects WHERE business_id = $1 AND id = $2",
  task_schedule: "SELECT title AS label FROM business_task_schedules WHERE business_id = $1 AND id = $2",
  task_template: "SELECT name AS label FROM business_task_templates WHERE business_id = $1 AND id = $2",
};
async function restaurantAudit(db, scope, action, entityId, details) {
  const [entityType, rawVerb] = action.split(".");
  // A change that hands the task to someone reads as "assigned".
  const verb = entityType === "task" && rawVerb === "updated" && details.assignees ? "assigned" : rawVerb;
  // The title is the row's label; empty values say nothing to an owner reading the log.
  const shown = Object.fromEntries(Object.entries(details).filter(([k, v]) => !["title", "name"].includes(k) && v !== null && v !== undefined && v !== ""));
  if (Array.isArray(shown.assignees)) shown.assignees = shown.assignees.length;
  await db.query("SAVEPOINT tasks_restaurant_audit");
  try {
    let label = details.title || details.name || null;
    if (!label && LABELS[entityType] && entityId) label = (await one(db, LABELS[entityType], [scope.businessId, entityId]))?.label || null;
    if (!label && details.number) label = `#${details.number}`;
    await db.query(
      `INSERT INTO audit_logs (restaurant_id, user_id, user_name, action, entity_type, entity_id, entity_label, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [scope.restaurantId, scope.userId, scope.userName || null, verb, entityType, entityId || null, label ? String(label).slice(0, 150) : null, JSON.stringify(shown)]);
    await db.query("RELEASE SAVEPOINT tasks_restaurant_audit");
  } catch (error) {
    await db.query("ROLLBACK TO SAVEPOINT tasks_restaurant_audit");
    console.error("Could not write the restaurant audit log:", error.message);
  }
}

// The outbox (a later WhatsApp / SMS publisher tells people).
async function event(db, scope, kind, entityType, entityId, payload = {}) {
  await db.query(
    `INSERT INTO business_events (business_id, kind, entity_type, entity_id, payload, actor_id) VALUES ($1, $2, $3, $4, $5, $6)`,
    [scope.businessId, kind, entityType, entityId, JSON.stringify(payload), scope.userId]
  );
}

// Builds "$1, $2 …" placeholders as values are added, so SQL fragments
// written in different functions can share one parameter list.
class Params {
  constructor(values = []) { this.values = [...values]; }
  add(value) { this.values.push(value); return `$${this.values.length}`; }
}

module.exports = { pool, transaction, one, all, history, audit, event, Params };
