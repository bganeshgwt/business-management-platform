// Expenses entered but not yet approved. Money already spent — a gas refill, a
// plumber — that the books do not count until someone signs it off.
//
// Only for people who can approve (expenses.manage): someone who can read the
// list but not act on it gains nothing from being reminded of it.
//
// A failed query rejects, so the registry reports this area as "could not
// check" instead of "all clear".
const { completeContext } = require("..");

// Anything waiting longer than this is holding up the books, and whoever paid
// out of their own pocket is still waiting to be reimbursed.
const OVERDUE_HOURS = 48;
const NAMED_LIMIT = 5;
// The biggest few recent ones, named in the summary's second line.
const LISTED = 3;

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "22 Sep". Built by hand: en-IN spells September "Sept", unlike every
// other screen in the app.
const dateLabel = (isoDate) => {
  const [, month, day] = isoDate.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}`;
};

const daysWaiting = (from, now) =>
  Math.max(1, Math.floor((now.getTime() - new Date(from).getTime()) / 86400000));

async function collectAlerts({ restaurantId, now, pool, money }) {
  // Reads the partial index of pending expenses only. Each group — overdue,
  // and recent — is ranked in SQL and carries its own count, total and ids,
  // so the amounts in the words are over every pending expense, however
  // many there are, while only the handful that get named come back as rows.
  const result = await pool.query(
    `WITH pending AS (
       SELECT e.id, e.amount, e.expense_date, e.created_at, e.notes,
              e.expense_category_id, e.supplier_id, e.created_by,
              (e.created_at <= $2::timestamptz - make_interval(hours => $3)) AS overdue
       FROM expenses e
       WHERE e.restaurant_id = $1 AND e.expense_status = 'pending'
     ),
     ranked AS (
       SELECT p.*,
              ROW_NUMBER() OVER (PARTITION BY p.overdue ORDER BY p.created_at, p.id) AS age_rank,
              ROW_NUMBER() OVER (PARTITION BY p.overdue ORDER BY p.amount DESC, p.id) AS size_rank,
              ROW_NUMBER() OVER (PARTITION BY p.overdue ORDER BY p.created_at DESC, p.id DESC) AS new_rank
       FROM pending p
     ),
     summed AS (
       SELECT r.*,
              COUNT(*) OVER (PARTITION BY r.overdue) AS group_count,
              SUM(r.amount) OVER (PARTITION BY r.overdue) AS group_total,
              array_agg(r.id) OVER (PARTITION BY r.overdue) AS group_ids,
              COUNT(*) FILTER (WHERE r.age_rank > $4::int) OVER (PARTITION BY r.overdue) AS rest_count,
              SUM(r.amount) FILTER (WHERE r.age_rank > $4::int) OVER (PARTITION BY r.overdue) AS rest_total,
              array_agg(r.id) FILTER (WHERE r.age_rank > $4::int) OVER (PARTITION BY r.overdue) AS rest_ids,
              MIN(r.created_at) FILTER (WHERE r.age_rank > $4::int) OVER (PARTITION BY r.overdue) AS rest_oldest
       FROM ranked r
     )
     SELECT s.id, s.amount, s.expense_date::text AS expense_date, s.created_at, s.notes, s.overdue,
            s.age_rank, s.size_rank, s.new_rank,
            s.group_count, s.group_total, s.group_ids,
            s.rest_count, s.rest_total, s.rest_ids, s.rest_oldest,
            c.name AS category, sup.name AS supplier, u.name AS entered_by
     FROM summed s
     JOIN expense_categories c ON c.id = s.expense_category_id
     LEFT JOIN suppliers sup ON sup.id = s.supplier_id
     LEFT JOIN users u ON u.id = s.created_by
     WHERE (s.overdue AND s.age_rank <= $4::int)
        OR (NOT s.overdue AND (s.size_rank <= $5::int OR s.new_rank = 1))
     ORDER BY s.overdue DESC, s.age_rank`,
    [restaurantId, now.toISOString(), OVERDUE_HOURS, NAMED_LIMIT, LISTED]
  );

  const overdue = result.rows.filter((row) => row.overdue);
  const recent = result.rows.filter((row) => !row.overdue);
  const alerts = [];

  for (const row of overdue) {
    alerts.push({
      id: `expenses:overdue:${row.id}`,
      severity: "warning",
      title: `${row.category} expense of ${money(row.amount)} waiting ${plural(
        daysWaiting(row.created_at, now),
        "day",
        "days"
      )} for approval`,
      detail: [
        row.supplier || (row.notes ? row.notes.replace(/\s+/g, " ").slice(0, 60) : null),
        `spent ${dateLabel(row.expense_date)}`,
        row.entered_by ? `entered by ${row.entered_by}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      link: "/expenses?status=pending",
      category: "Expenses",
      at: new Date(new Date(row.created_at).getTime() + OVERDUE_HOURS * 3600000).toISOString(),
    });
  }

  const overdueRest = overdue.length ? Number(overdue[0].rest_count) : 0;

  if (overdueRest > 0) {
    alerts.push({
      // One id, with the expenses behind it as members: approving one leaves
      // this read, another passing two days makes it news.
      id: "expenses:overdue-more",
      members: overdue[0].rest_ids || [],
      severity: "warning",
      title: `${plural(overdueRest, "more expense", "more expenses")} waiting over 2 days — ${money(
        overdue[0].rest_total
      )}`,
      detail: "Approve or reject them so the books close cleanly",
      link: "/expenses?status=pending",
      category: "Expenses",
      at: new Date(new Date(overdue[0].rest_oldest).getTime() + OVERDUE_HOURS * 3600000).toISOString(),
    });
  }

  if (recent.length > 0) {
    const count = Number(recent[0].group_count);
    const newest = recent.find((row) => Number(row.new_rank) === 1);
    // Biggest first: that is the one an approver looks at before signing.
    const listed = recent
      .filter((row) => Number(row.size_rank) <= LISTED)
      .sort((a, b) => Number(a.size_rank) - Number(b.size_rank))
      .map((row) => `${row.category} ${money(row.amount)}`);

    alerts.push({
      // One summary for everything recent, with the expenses behind it as
      // members: a new expense makes it worth reading again, approving one
      // does not.
      id: "expenses:pending",
      members: recent[0].group_ids || [],
      severity: "info",
      title:
        count === 1
          ? `${newest.category} expense of ${money(newest.amount)} awaiting approval`
          : `${count} expenses awaiting approval — ${money(recent[0].group_total)}`,
      detail:
        count === 1
          ? [newest.supplier, newest.entered_by ? `entered by ${newest.entered_by}` : null]
              .filter(Boolean)
              .join(" · ") || null
          : `${listed.join(" · ")}${count > LISTED ? ` · +${count - LISTED} more` : ""}`,
      link: "/expenses?status=pending",
      category: "Expenses",
      at: new Date(newest.created_at).toISOString(),
    });
  }

  return alerts;
}

module.exports = {
  key: "expenses",
  permission: "expenses.manage",

  collect: (context) => collectAlerts(completeContext(context)),
};
