const repo = require("../repositories/tasks.repository");
const recurrence = require("./recurrence.service");
const { fail, id, dateText, localToday, addDays, daysBetween } = require("./common");

// Task reports for a period (the due day, in the business's time zone).
//
//   completion rate   done ÷ (done + missed + still open past due) of tasks due in the period
//   on-time %         done by the due time ÷ done (tasks with a due time)
//   missed            by person (assigned people and staff records) and by category
//   open issues       by age (0–1, 2–3, 4–7, 8+ days), category and severity
//   compliance        per recurring task: occurrences done ÷ due, with the day strip
//   review backlog    done and waiting for a review

async function report(scope, query = {}) {
  await scope.require("tasks.view");
  await recurrence.ensure(scope);
  const today = localToday(scope.timezone);
  const to = dateText(query.to, "To") || today;
  const from = dateText(query.from, "From") || addDays(to, -29);
  if (from > to || daysBetween(from, to) > 366) fail(400, "Choose a period of up to a year");
  const placeId = query.place ? id(query.place, "Place") : null;
  const placeColumn = scope.world === "restaurant" ? "outlet_id" : "location_id";
  // Someone tied to one outlet reports on that outlet.
  const outlet = scope.outletScope || (scope.world === "restaurant" ? placeId : null);
  const location = scope.world === "business" ? placeId : null;
  const base = [scope.businessId, scope.timezone, from, to, outlet, location];
  const inPeriod = `t.business_id = $1 AND (t.due_at AT TIME ZONE $2)::date BETWEEN $3 AND $4 AND t.status <> 'cancelled'
    AND ($5::bigint IS NULL OR t.outlet_id = $5) AND ($6::bigint IS NULL OR t.location_id = $6)`;
  // Due by now: past its due time, or already done.
  const counted = `(t.status IN ('done', 'missed') OR t.due_at < now())`;

  const [totals, byCategory, byPerson, schedules, issuesAge, issuesCategory, reviewBacklog, daily] = await Promise.all([
    repo.one(repo.pool, `SELECT count(*) FILTER (WHERE ${counted}) AS due,
        count(*) FILTER (WHERE t.status = 'done') AS done,
        count(*) FILTER (WHERE t.status = 'done' AND t.completed_at <= t.due_at) AS on_time,
        count(*) FILTER (WHERE t.status = 'missed') AS missed,
        count(*) FILTER (WHERE t.status IN ('todo', 'in_progress') AND t.due_at < now()) AS overdue,
        count(*) FILTER (WHERE t.status IN ('todo', 'in_progress') AND t.due_at >= now()) AS upcoming,
        count(*) FILTER (WHERE t.failed_count > 0) AS with_failures,
        round(avg(t.score_percent) FILTER (WHERE t.status = 'done' AND t.score_percent IS NOT NULL), 1) AS average_score
      FROM business_tasks t WHERE ${inPeriod}`, base),
    repo.all(repo.pool, `SELECT t.category_code AS category, count(*) FILTER (WHERE ${counted}) AS due, count(*) FILTER (WHERE t.status = 'done') AS done,
        count(*) FILTER (WHERE t.status = 'missed') AS missed, count(*) FILTER (WHERE t.status = 'done' AND t.completed_at <= t.due_at) AS on_time
      FROM business_tasks t WHERE ${inPeriod} GROUP BY t.category_code ORDER BY count(*) FILTER (WHERE t.status = 'missed') DESC, t.category_code`, base),
    // Per person: tasks they were named on (directly or by their staff record), and what they did themselves.
    repo.all(repo.pool, `WITH named AS (
        SELECT t.id, t.status, t.due_at, t.completed_at, t.completed_by,
          COALESCE(a.user_id, e.user_id) AS user_id, CASE WHEN a.user_id IS NULL AND e.user_id IS NULL THEN COALESCE(a.employee_id, a.resource_id) END AS other_id,
          COALESCE(u.name, e.name, r.name) AS name, a.kind
        FROM business_tasks t JOIN business_task_assignees a ON a.business_id = t.business_id AND a.task_id = t.id AND a.kind IN ('user', 'employee', 'resource')
        LEFT JOIN users u ON u.id = a.user_id LEFT JOIN employees e ON e.id = a.employee_id
        LEFT JOIN business_resources r ON r.business_id = a.business_id AND r.id = a.resource_id
        WHERE ${inPeriod})
      SELECT COALESCE(user_id::text, kind || ':' || other_id) AS person, max(name) AS name,
        count(*) FILTER (WHERE status IN ('done', 'missed') OR due_at < now()) AS due, count(*) FILTER (WHERE status = 'done') AS done,
        count(*) FILTER (WHERE status = 'done' AND completed_at <= due_at) AS on_time, count(*) FILTER (WHERE status = 'missed') AS missed,
        count(*) FILTER (WHERE status IN ('todo', 'in_progress') AND due_at < now()) AS overdue
      FROM named GROUP BY 1 ORDER BY count(*) FILTER (WHERE status = 'missed') DESC, max(name) LIMIT 200`, base),
    repo.all(repo.pool, `SELECT s.id, s.title, s.frequency, s.category_code AS category, s.active,
        count(t.id) FILTER (WHERE ${counted}) AS due, count(t.id) FILTER (WHERE t.status = 'done') AS done,
        count(t.id) FILTER (WHERE t.status = 'done' AND t.completed_at <= t.due_at) AS on_time, count(t.id) FILTER (WHERE t.status = 'missed') AS missed,
        count(t.id) FILTER (WHERE t.failed_count > 0) AS with_failures,
        COALESCE(json_agg(json_build_object('day', t.occurrence_date::text, 'status', t.status, 'failed', t.failed_count > 0) ORDER BY t.occurrence_date, t.occurrence_slot) FILTER (WHERE t.id IS NOT NULL), '[]') AS days
      FROM business_task_schedules s JOIN business_tasks t ON t.business_id = s.business_id AND t.schedule_id = s.id AND ${inPeriod}
      WHERE s.business_id = $1 GROUP BY s.id ORDER BY s.title`, base),
    repo.all(repo.pool, `SELECT CASE WHEN age < 2 THEN '0–1 days' WHEN age < 4 THEN '2–3 days' WHEN age < 8 THEN '4–7 days' ELSE '8+ days' END AS bucket,
        min(age) AS sort, count(*) AS open, count(*) FILTER (WHERE severity IN ('high', 'critical')) AS serious
      FROM (SELECT i.severity, ((now() AT TIME ZONE $2)::date - (i.reported_at AT TIME ZONE $2)::date) AS age FROM business_issues i
        WHERE i.business_id = $1 AND i.status IN ('open', 'in_progress') AND ($3::bigint IS NULL OR i.outlet_id = $3) AND ($4::bigint IS NULL OR i.location_id = $4)) x
      GROUP BY 1 ORDER BY 2`, [scope.businessId, scope.timezone, outlet, location]),
    repo.all(repo.pool, `SELECT i.category_code AS category, count(*) FILTER (WHERE i.status IN ('open', 'in_progress')) AS open,
        count(*) FILTER (WHERE i.status IN ('open', 'in_progress') AND i.severity IN ('high', 'critical')) AS serious,
        count(*) FILTER (WHERE (i.reported_at AT TIME ZONE $2)::date BETWEEN $3 AND $4) AS reported,
        count(*) FILTER (WHERE (i.resolved_at AT TIME ZONE $2)::date BETWEEN $3 AND $4) AS resolved,
        round(avg(EXTRACT(EPOCH FROM (i.resolved_at - i.reported_at)) / 3600) FILTER (WHERE (i.resolved_at AT TIME ZONE $2)::date BETWEEN $3 AND $4), 1) AS hours_to_fix
      FROM business_issues i WHERE i.business_id = $1 AND ($5::bigint IS NULL OR i.outlet_id = $5) AND ($6::bigint IS NULL OR i.location_id = $6)
      GROUP BY 1 HAVING count(*) FILTER (WHERE i.status IN ('open', 'in_progress')) > 0 OR count(*) FILTER (WHERE (i.reported_at AT TIME ZONE $2)::date BETWEEN $3 AND $4) > 0
      ORDER BY 2 DESC, 1`, base),
    repo.one(repo.pool, `SELECT count(*) AS n, min(t.completed_at) AS oldest FROM business_tasks t WHERE t.business_id = $1 AND t.status = 'done' AND t.review_status = 'pending'
      AND ($2::bigint IS NULL OR t.outlet_id = $2) AND ($3::bigint IS NULL OR t.location_id = $3)`, [scope.businessId, outlet, location]),
    repo.all(repo.pool, `SELECT (t.due_at AT TIME ZONE $2)::date::text AS day, count(*) FILTER (WHERE ${counted}) AS due, count(*) FILTER (WHERE t.status = 'done') AS done,
        count(*) FILTER (WHERE t.status = 'missed') AS missed FROM business_tasks t WHERE ${inPeriod} GROUP BY 1 ORDER BY 1`, base),
  ]);
  const n = (x) => Number(x || 0);
  const pct = (a, b) => (n(b) ? Math.round((1000 * n(a)) / n(b)) / 10 : null);
  const rate = (r) => ({ due: n(r.due), done: n(r.done), onTime: n(r.on_time), missed: n(r.missed),
    completionRate: pct(r.done, r.due), onTimeRate: pct(r.on_time, r.done) });
  return {
    from, to, placeId: outlet || location || null,
    totals: { ...rate(totals), overdue: n(totals.overdue), upcoming: n(totals.upcoming), withFailures: n(totals.with_failures),
      averageScore: totals.average_score === null ? null : Number(totals.average_score) },
    byCategory: byCategory.map((r) => ({ category: r.category, ...rate(r) })),
    byPerson: byPerson.map((r) => ({ person: r.person, name: r.name, ...rate(r), overdue: n(r.overdue) })),
    compliance: schedules.map((r) => ({ scheduleId: Number(r.id), title: r.title, frequency: r.frequency, category: r.category, active: r.active,
      ...rate(r), withFailures: n(r.with_failures), days: r.days })),
    issuesByAge: issuesAge.map((r) => ({ bucket: r.bucket, open: n(r.open), serious: n(r.serious) })),
    issuesByCategory: issuesCategory.map((r) => ({ category: r.category, open: n(r.open), serious: n(r.serious), reported: n(r.reported), resolved: n(r.resolved),
      hoursToFix: r.hours_to_fix === null ? null : Number(r.hours_to_fix) })),
    reviewBacklog: { count: n(reviewBacklog.n), oldest: reviewBacklog.oldest },
    daily: daily.map((r) => ({ day: r.day, due: n(r.due), done: n(r.done), missed: n(r.missed) })),
  };
}

// The dashboard card and the bell: today's checklists, what is overdue, issues waiting.
async function summary(scope) {
  await recurrence.ensure(scope);
  const people = require("./people.service");
  const today = localToday(scope.timezone);
  const p = new repo.Params([scope.businessId, scope.timezone, today]);
  const visible = people.visibleSql(scope, p, "t");
  const mine = people.mineSql(scope, p, "t");
  const row = await repo.one(repo.pool, `SELECT
      count(*) FILTER (WHERE (t.due_at AT TIME ZONE $2)::date = $3 AND t.status <> 'cancelled') AS today_total,
      count(*) FILTER (WHERE (t.due_at AT TIME ZONE $2)::date = $3 AND t.status = 'done') AS today_done,
      count(*) FILTER (WHERE (t.due_at AT TIME ZONE $2)::date = $3 AND t.status = 'missed') AS today_missed,
      count(*) FILTER (WHERE t.status IN ('todo', 'in_progress') AND t.due_at < now()) AS overdue,
      count(*) FILTER (WHERE t.status = 'done' AND t.review_status = 'pending') AS review,
      count(*) FILTER (WHERE ${mine} AND t.status IN ('todo', 'in_progress') AND (t.due_at IS NULL OR (t.due_at AT TIME ZONE $2)::date <= $3)) AS mine_open,
      count(*) FILTER (WHERE ${mine} AND t.status IN ('todo', 'in_progress') AND t.due_at < now()) AS mine_overdue,
      count(*) FILTER (WHERE ${mine} AND t.status = 'done' AND (t.completed_at AT TIME ZONE $2)::date = $3) AS mine_done,
      min(t.due_at) FILTER (WHERE t.status IN ('todo', 'in_progress') AND t.due_at < now()) AS oldest_overdue
    FROM business_tasks t WHERE t.business_id = $1 AND ${visible} AND (t.due_at IS NULL OR t.due_at < ($3::date + 2)::timestamp AT TIME ZONE $2)`, p.values);
  let issues = null;
  if (scope.has("issues")) {
    const ip = new repo.Params([scope.businessId]);
    const visibleIssues = require("./issues.service").visibleSql(scope, ip, "i");
    const uid = ip.add(scope.userId);
    const x = await repo.one(repo.pool, `SELECT count(*) FILTER (WHERE i.status IN ('open', 'in_progress')) AS open,
        count(*) FILTER (WHERE i.status IN ('open', 'in_progress') AND i.severity IN ('high', 'critical')) AS serious,
        count(*) FILTER (WHERE i.status = 'open' AND i.assignee_user_id IS NULL) AS unassigned,
        count(*) FILTER (WHERE i.status IN ('open', 'in_progress') AND i.assignee_user_id = ${uid}) AS mine,
        count(*) FILTER (WHERE i.status = 'resolved') AS to_close,
        min(i.reported_at) FILTER (WHERE i.status IN ('open', 'in_progress') AND i.severity IN ('high', 'critical')) AS oldest_serious
      FROM business_issues i WHERE i.business_id = $1 AND ${visibleIssues}`, ip.values);
    issues = { open: Number(x.open), serious: Number(x.serious), unassigned: Number(x.unassigned), mine: Number(x.mine), toClose: Number(x.to_close), oldestSerious: x.oldest_serious };
  }
  return {
    today,
    team: scope.can("tasks.view"),
    todayTotal: Number(row.today_total), todayDone: Number(row.today_done), todayMissed: Number(row.today_missed),
    overdue: Number(row.overdue), oldestOverdue: row.oldest_overdue, review: scope.can("tasks.review") ? Number(row.review) : 0,
    mine: { open: Number(row.mine_open), overdue: Number(row.mine_overdue), done: Number(row.mine_done) },
    issues,
  };
}

module.exports = { report, summary };
