// Unhappy guests: complaints nobody has closed, and today's poor ratings that
// nobody has read yet. Both are cheapest to fix the same day — a call from
// the manager tonight keeps a regular; a reply next week does not.
//
// Filed under "Complaints & feedback", the same words the notifications page
// uses for this area, so the category and the area never disagree — the
// separate Guests area (birthdays, regulars) is a different provider.
//
// A failed query rejects, so the registry reports this area as "could not
// check" instead of "all clear".
const { completeContext } = require("..");

// Past a day, an open complaint is a guest who has heard nothing back.
const STALE_HOURS = 24;
const NAMED_LIMIT = 5;
const LOW_RATING = 2;
const CATEGORY = "Complaints & feedback";

const CATEGORY_LABELS = {
  food: "Food",
  service: "Service",
  delivery: "Delivery",
  billing: "Billing",
  hygiene: "Hygiene",
  other: "Other",
};

const SOURCE_LABELS = {
  in_store: "in store",
  qr: "via table QR",
  website: "via website",
  phone: "by phone",
  other: null,
};

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const age = (from, now) => {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(from).getTime()) / 60000));

  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
};

// A comment long enough to be useful in a dropdown, short enough to fit.
const quote = (text, limit = 90) => {
  if (!text) {
    return null;
  }

  const flat = text.replace(/\s+/g, " ").trim();
  return `“${flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat}”`;
};

async function collectAlerts({ restaurantId, businessDate, timezone, now, pool }) {
  const at = now.toISOString();

  const [complaints, feedback] = await Promise.all([
    // idx_complaints_status holds the open ones together. The named few come
    // back as rows; everything after them as counts and ids on those rows.
    pool.query(
      `WITH open_complaints AS (
         SELECT c.*,
                (c.priority = 'high'
                 OR c.created_at <= $2::timestamptz - make_interval(hours => $3)) AS urgent
         FROM complaints c
         WHERE c.restaurant_id = $1 AND c.complaint_status IN ('open', 'in_progress')
       ),
       ranked AS (
         SELECT oc.*, ROW_NUMBER() OVER (ORDER BY oc.urgent DESC, oc.created_at, oc.id) AS position
         FROM open_complaints oc
       ),
       summed AS (
         SELECT r.*,
                COUNT(*) OVER () AS total_count,
                COUNT(*) FILTER (WHERE r.position > $4::int AND r.urgent) OVER () AS rest_urgent,
                array_agg(r.id) FILTER (WHERE r.position > $4::int) OVER () AS rest_ids,
                MAX(r.created_at) FILTER (WHERE r.position > $4::int) OVER () AS rest_newest
         FROM ranked r
       )
       SELECT s.id, s.subject, s.category, s.priority, s.complaint_status, s.customer_name,
              s.created_at, s.urgent, s.total_count, s.rest_urgent, s.rest_ids, s.rest_newest,
              u.name AS assigned_name
       FROM summed s
       LEFT JOIN users u ON u.id = s.assigned_to
       WHERE s.position <= $4::int
       ORDER BY s.position`,
      [restaurantId, at, STALE_HOURS, NAMED_LIMIT]
    ),
    // "Today" is the business day, measured from its local midnight, so a
    // one-star left at 00:40 during a late service still counts as tonight's.
    pool.query(
      `WITH poor AS (
         SELECT f.id, f.rating, f.comments, f.customer_name, f.source, f.created_at,
                ROW_NUMBER() OVER (ORDER BY f.rating, f.created_at DESC, f.id) AS position
         FROM feedback f
         WHERE f.restaurant_id = $1
           AND f.rating <= $2
           AND f.feedback_status = 'new'
           AND f.created_at >= ($3::date::timestamp AT TIME ZONE $4::text)
       ),
       summed AS (
         SELECT p.*,
                COUNT(*) OVER () AS total_count,
                array_agg(p.id) FILTER (WHERE p.position > $5::int) OVER () AS rest_ids,
                MAX(p.created_at) FILTER (WHERE p.position > $5::int) OVER () AS rest_newest
         FROM poor p
       )
       SELECT * FROM summed WHERE position <= $5::int ORDER BY position`,
      [restaurantId, LOW_RATING, businessDate, timezone, NAMED_LIMIT]
    ),
  ]);

  const alerts = [];
  const openRows = complaints.rows;

  for (const row of openRows) {
    const high = row.priority === "high";
    const severity = row.urgent ? "critical" : "warning";
    const staleAt = new Date(new Date(row.created_at).getTime() + STALE_HOURS * 3600000);

    alerts.push({
      id: `crm:complaint:${row.id}:${severity}`,
      severity,
      title: `Complaint: ${row.subject}`,
      detail: [
        row.customer_name || "Guest",
        CATEGORY_LABELS[row.category] || null,
        high ? "high priority" : null,
        `${row.complaint_status === "in_progress" ? "in progress" : "open"} ${age(row.created_at, now)}`,
        row.assigned_name ? `with ${row.assigned_name}` : "nobody assigned",
      ]
        .filter(Boolean)
        .join(" · "),
      link: `/crm/complaints?status=${row.complaint_status}`,
      category: CATEGORY,
      // Urgent because it has aged: it became urgent a day after it was made.
      at: (severity === "critical" && !high ? staleAt : new Date(row.created_at)).toISOString(),
    });
  }

  const totalOpen = openRows.length ? Number(openRows[0].total_count) : 0;

  if (totalOpen > NAMED_LIMIT) {
    const restCount = totalOpen - NAMED_LIMIT;
    const restUrgent = Number(openRows[0].rest_urgent);
    const severity = restUrgent > 0 ? "critical" : "warning";

    alerts.push({
      // One id per severity, with the complaints behind it as members:
      // closing one leaves this read, a new complaint makes it news.
      id: `crm:complaint-more:${severity}`,
      members: openRows[0].rest_ids || [],
      severity,
      title: `${plural(restCount, "more complaint", "more complaints")} still open`,
      detail:
        restUrgent > 0
          ? `${restUrgent} of them high priority or waiting over ${STALE_HOURS} h`
          : "None urgent yet — work through them before they age",
      link: "/crm/complaints?status=open",
      category: CATEGORY,
      at: new Date(openRows[0].rest_newest || now).toISOString(),
    });
  }

  const poor = feedback.rows;

  for (const row of poor) {
    alerts.push({
      id: `crm:feedback:${row.id}`,
      severity: "warning",
      title: `${row.rating}★ from ${row.customer_name || "a guest"} ${
        SOURCE_LABELS[row.source] || ""
      }`.trim(),
      detail: quote(row.comments) || "No comment left — worth a call if you have their number",
      link: "/crm/feedback",
      category: CATEGORY,
      at: new Date(row.created_at).toISOString(),
    });
  }

  const totalPoor = poor.length ? Number(poor[0].total_count) : 0;

  if (totalPoor > NAMED_LIMIT) {
    alerts.push({
      id: "crm:feedback-more",
      members: poor[0].rest_ids || [],
      severity: "warning",
      title: `${plural(totalPoor - NAMED_LIMIT, "more poor rating", "more poor ratings")} today`,
      detail: "Rated 1 or 2 stars and not yet reviewed",
      link: "/crm/feedback",
      category: CATEGORY,
      at: new Date(poor[0].rest_newest || now).toISOString(),
    });
  }

  return alerts;
}

module.exports = {
  key: "crm",
  permission: "feedback.view",
  // Not asked while this restaurant feature is switched off (Settings -> Features).
  feature: "guests",

  collect: (context) => collectAlerts(completeContext(context)),
};
