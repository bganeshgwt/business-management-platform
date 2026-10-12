const repo = require("../repositories/tasks.repository");
const access = require("../../business/core/services/businessAccess.service");

// Business Admin bell entries for tasks and issues (added to
// businessNotifications.feed). Everyone: their own overdue tasks and issues
// assigned to them. tasks.view / tasks.review / issues.view: the team's.

async function forBusiness(business) {
  const has = (m) => business.modules.includes(m);
  if (!has("tasks")) return [];
  const can = (p) => access.can(business, p);
  const base = `/business-admin/${business.id}/tasks`;
  const userId = business.member_user_id || null;
  const items = [];
  const t = await repo.one(repo.pool, `SELECT
      count(*) FILTER (WHERE status IN ('todo', 'in_progress') AND due_at < now()) AS overdue,
      min(due_at) FILTER (WHERE status IN ('todo', 'in_progress') AND due_at < now()) AS oldest,
      count(*) FILTER (WHERE status = 'done' AND review_status = 'pending') AS review,
      min(completed_at) FILTER (WHERE status = 'done' AND review_status = 'pending') AS review_since,
      count(*) FILTER (WHERE status IN ('todo', 'in_progress') AND due_at < now() AND $2::bigint IS NOT NULL AND (started_by = $2
        OR EXISTS (SELECT 1 FROM business_task_assignees a WHERE a.business_id = t.business_id AND a.task_id = t.id AND a.user_id = $2))) AS mine
    FROM business_tasks t WHERE business_id = $1 AND status IN ('todo', 'in_progress', 'done') AND (due_at IS NULL OR due_at > now() - interval '14 days')`,
  [business.id, userId]);
  const n = (x) => Number(x || 0);
  const nowIso = new Date().toISOString();
  if (n(t.mine)) {
    items.push({ id: `tasks:mine-overdue:${n(t.mine)}`, severity: "warning", category: "Tasks",
      title: `You have ${n(t.mine)} overdue task${n(t.mine) === 1 ? "" : "s"}`, detail: "Open My tasks to finish them", at: nowIso, link: base });
  }
  if (can("tasks.view") && n(t.overdue)) {
    items.push({ id: `tasks:overdue:${n(t.overdue)}`, severity: "warning", category: "Tasks",
      title: `${n(t.overdue)} task${n(t.overdue) === 1 ? "" : "s"} overdue in the team`, detail: "Still not done after their due time",
      at: new Date(t.oldest).toISOString(), link: `${base}/board?status=overdue` });
  }
  if (can("tasks.review") && n(t.review)) {
    items.push({ id: `tasks:review:${n(t.review)}`, severity: "info", category: "Tasks",
      title: `${n(t.review)} finished task${n(t.review) === 1 ? "" : "s"} waiting for review`, detail: "Approve them or send them back",
      at: new Date(t.review_since).toISOString(), link: `${base}/board?status=review` });
  }
  if (has("issues")) {
    const i = await repo.one(repo.pool, `SELECT
        count(*) FILTER (WHERE status IN ('open', 'in_progress') AND severity IN ('high', 'critical')) AS serious,
        count(*) FILTER (WHERE status IN ('open', 'in_progress') AND severity = 'critical') AS critical,
        min(reported_at) FILTER (WHERE status IN ('open', 'in_progress') AND severity IN ('high', 'critical')) AS since,
        count(*) FILTER (WHERE status IN ('open', 'in_progress') AND assignee_user_id = $2) AS mine
      FROM business_issues WHERE business_id = $1`, [business.id, userId]);
    if (n(i.mine)) {
      items.push({ id: `issues:mine:${n(i.mine)}`, severity: "info", category: "Issues",
        title: `${n(i.mine)} issue${n(i.mine) === 1 ? "" : "s"} assigned to you`, at: nowIso, link: `${base}/issues?assignee=me` });
    }
    if (can("issues.view") && n(i.serious)) {
      items.push({ id: `issues:serious:${n(i.serious)}:${n(i.critical)}`, severity: n(i.critical) ? "critical" : "warning", category: "Issues",
        title: `${n(i.serious)} serious issue${n(i.serious) === 1 ? "" : "s"} open`, detail: n(i.critical) ? `${n(i.critical)} critical` : "High severity, not fixed yet",
        at: new Date(i.since).toISOString(), link: `${base}/issues?status=active` });
    }
  }
  return items;
}

module.exports = { forBusiness };
