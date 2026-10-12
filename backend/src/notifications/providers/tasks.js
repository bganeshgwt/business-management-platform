// Tasks & issues (modules/tasks): what a manager should look at now.
//
//   overdue tasks        still open past their due time (today's trading day and before)
//   waiting for review   done, needing a manager's approval
//   serious issues       high / critical issues still open
//   issues to close      fixed (resolved) and waiting to be checked and closed
//
// Summary alerts with counts, never task titles: the bell is worked out per
// restaurant, and a person tied to one outlet must not read another outlet's
// work here. The task screens show each person only what they may see.

const tasksBusiness = async (pool, restaurantId) =>
  (await pool.query("SELECT id FROM businesses WHERE legacy_restaurant_id = $1", [restaurantId])).rows[0]?.id || null;

module.exports = {
  key: "tasks",
  label: "Tasks & issues",
  permission: "tasks.view",
  feature: "tasks",

  collect: async ({ restaurantId, now, pool }) => {
    try {
      const businessId = await tasksBusiness(pool, restaurantId);
      if (!businessId) return [];
      const { rows: [t] } = await pool.query(
        `SELECT count(*) FILTER (WHERE status IN ('todo', 'in_progress') AND due_at < $2) AS overdue,
                min(due_at) FILTER (WHERE status IN ('todo', 'in_progress') AND due_at < $2) AS oldest,
                count(*) FILTER (WHERE status = 'done' AND review_status = 'pending') AS review,
                min(completed_at) FILTER (WHERE status = 'done' AND review_status = 'pending') AS review_since
         FROM business_tasks WHERE business_id = $1 AND (status IN ('todo', 'in_progress', 'done'))
           AND (due_at IS NULL OR due_at > $2 - interval '14 days')`,
        [businessId, now]
      );
      const { rows: [i] } = await pool.query(
        `SELECT count(*) FILTER (WHERE status IN ('open', 'in_progress') AND severity IN ('high', 'critical')) AS serious,
                count(*) FILTER (WHERE status IN ('open', 'in_progress') AND severity = 'critical') AS critical,
                min(reported_at) FILTER (WHERE status IN ('open', 'in_progress') AND severity IN ('high', 'critical')) AS serious_since,
                count(*) FILTER (WHERE status = 'resolved') AS to_close,
                min(resolved_at) FILTER (WHERE status = 'resolved') AS to_close_since
         FROM business_issues WHERE business_id = $1`,
        [businessId]
      );
      const alerts = [];
      const n = (x) => Number(x || 0);
      if (n(t.overdue)) {
        alerts.push({
          id: `tasks:overdue:${n(t.overdue)}`, severity: "warning", category: "Tasks",
          title: `${n(t.overdue)} task${n(t.overdue) === 1 ? "" : "s"} overdue`,
          detail: "Still not done after their due time", link: "/tasks/board?status=overdue", at: new Date(t.oldest).toISOString(),
        });
      }
      if (n(t.review)) {
        alerts.push({
          id: `tasks:review:${n(t.review)}`, severity: "info", category: "Tasks",
          title: `${n(t.review)} finished task${n(t.review) === 1 ? "" : "s"} waiting for your review`,
          detail: "Approve them or send them back", link: "/tasks/board?status=review", at: new Date(t.review_since).toISOString(),
        });
      }
      if (n(i.serious)) {
        alerts.push({
          id: `tasks:issues:${n(i.serious)}:${n(i.critical)}`, severity: n(i.critical) ? "critical" : "warning", category: "Issues",
          title: `${n(i.serious)} serious issue${n(i.serious) === 1 ? "" : "s"} open`,
          detail: n(i.critical) ? `${n(i.critical)} critical` : "High severity, not fixed yet", link: "/tasks/issues?status=active", at: new Date(i.serious_since).toISOString(),
        });
      }
      if (n(i.to_close)) {
        alerts.push({
          id: `tasks:issues-to-close:${n(i.to_close)}`, severity: "info", category: "Issues",
          title: `${n(i.to_close)} fixed issue${n(i.to_close) === 1 ? "" : "s"} to check and close`,
          link: "/tasks/issues?status=resolved", at: new Date(i.to_close_since).toISOString(),
        });
      }
      return alerts;
    } catch (error) {
      console.error("tasks notifications:", error.message);
      return [];
    }
  },
};
