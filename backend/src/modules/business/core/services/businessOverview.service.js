const repo = require('../repositories/business.repository');
const access = require('./businessAccess.service');

// The Overview's picture of the day, beyond the headline figures (summary):
// the last fourteen days of sales, today so far against the same weekday a
// week ago at the same hour, sales by hour today, the best sellers, and for a
// business with appointments (a salon, a clinic) who is coming next and how
// each person's day is going. Each part only for someone allowed to see it;
// a person tied to a location, or a branch picked in the top bar, sees that
// location's.

const money = (value) => Number(value || 0).toFixed(2);

async function overview(business) {
  const location = business.location_scope || null;
  const seesSales = access.can(business, 'sales.view') || access.can(business, 'reports.view');
  const seesAppointments = business.modules.includes('appointments') && access.can(business, 'appointments.view');
  const seesCommission = business.modules.includes('commissions') && access.can(business, 'commissions.view');
  const tz = business.timezone;
  const values = [business.id, tz, location];
  const result = { generated_at: new Date().toISOString() };

  if (seesSales) {
    const [days, pace, hours, top, week] = await Promise.all([
      // Net sales per day: bills less what came back that day.
      repo.all(repo.pool, `WITH span AS (SELECT generate_series((now() AT TIME ZONE $2)::date - 13, (now() AT TIME ZONE $2)::date, '1 day')::date AS day)
        SELECT span.day::text AS day,
          COALESCE((SELECT sum(d.total) FROM business_documents d WHERE d.business_id=$1 AND d.kind='sale' AND (d.created_at AT TIME ZONE $2)::date=span.day AND ($3::bigint IS NULL OR d.location_id=$3)),0)
          - COALESCE((SELECT sum(r.total) FROM business_returns r JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id
              WHERE r.business_id=$1 AND d.kind='sale' AND (r.created_at AT TIME ZONE $2)::date=span.day AND ($3::bigint IS NULL OR d.location_id=$3)),0) AS sales,
          (SELECT count(*)::int FROM business_documents d WHERE d.business_id=$1 AND d.kind='sale' AND (d.created_at AT TIME ZONE $2)::date=span.day AND ($3::bigint IS NULL OR d.location_id=$3)) AS bills
        FROM span ORDER BY span.day`, values),
      // Today so far, and the same weekday last week up to the same time of day.
      repo.one(repo.pool, `SELECT
          COALESCE(sum(total) FILTER (WHERE (created_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date),0) AS today,
          COALESCE(sum(total) FILTER (WHERE (created_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date - 7 AND created_at <= now() - interval '7 days'),0) AS last_week_by_now,
          COALESCE(sum(total) FILTER (WHERE (created_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date - 7),0) AS last_week_day,
          count(*) FILTER (WHERE (created_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date)::int AS bills_today,
          to_char(now() AT TIME ZONE $2, 'Dy') AS weekday
        FROM business_documents WHERE business_id=$1 AND kind='sale' AND created_at >= now() - interval '8 days' AND ($3::bigint IS NULL OR location_id=$3)`, values),
      // Today by hour.
      repo.all(repo.pool, `SELECT extract(hour FROM created_at AT TIME ZONE $2)::int AS hour,count(*)::int AS bills,sum(total) AS sales
        FROM business_documents WHERE business_id=$1 AND kind='sale' AND (created_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date AND ($3::bigint IS NULL OR location_id=$3)
        GROUP BY 1 ORDER BY 1`, values),
      // Best sellers today, by value.
      repo.all(repo.pool, `SELECT dl.sku_id,max(dl.label) AS label,sum(dl.quantity) AS quantity,max(dl.unit) AS unit,sum(dl.net+dl.tax) AS value
        FROM business_document_lines dl JOIN business_documents d ON d.business_id=dl.business_id AND d.id=dl.document_id
        WHERE dl.business_id=$1 AND d.kind='sale' AND (d.created_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date AND ($3::bigint IS NULL OR d.location_id=$3)
        GROUP BY dl.sku_id ORDER BY sum(dl.net+dl.tax) DESC LIMIT 6`, values),
      // And over the last seven days, for a quiet morning.
      repo.all(repo.pool, `SELECT dl.sku_id,max(dl.label) AS label,sum(dl.quantity) AS quantity,max(dl.unit) AS unit,sum(dl.net+dl.tax) AS value
        FROM business_document_lines dl JOIN business_documents d ON d.business_id=dl.business_id AND d.id=dl.document_id
        WHERE dl.business_id=$1 AND d.kind='sale' AND d.created_at >= now() - interval '7 days' AND ($2::bigint IS NULL OR d.location_id=$2)
        GROUP BY dl.sku_id ORDER BY sum(dl.net+dl.tax) DESC LIMIT 6`, [business.id, location]),
    ]);
    const today = Number(pace.today);
    result.sales = {
      days: days.map((d) => ({ day: d.day, sales: money(d.sales), bills: d.bills })),
      today: money(today), bills_today: pace.bills_today,
      average_bill: pace.bills_today ? money(today / pace.bills_today) : null,
      last_week_by_now: money(pace.last_week_by_now), last_week_day: money(pace.last_week_day), weekday: pace.weekday,
      hours: hours.map((h) => ({ hour: h.hour, bills: h.bills, sales: money(h.sales) })),
      top_today: top.map((t) => ({ ...t, value: money(t.value) })), top_week: week.map((t) => ({ ...t, value: money(t.value) })),
    };
  }

  if (seesAppointments) {
    const [next, people] = await Promise.all([
      // Who is coming next today.
      repo.all(repo.pool, `SELECT a.id,a.starts_at,a.ends_at,c.name AS client,s.label AS service,r.name AS staff,
          (a.starts_at <= now() AND a.ends_at > now()) AS in_progress
        FROM business_appointments a JOIN business_contacts c ON c.business_id=a.business_id AND c.id=a.contact_id
        JOIN catalog_skus s ON s.business_id=a.business_id AND s.id=a.sku_id JOIN business_resources r ON r.business_id=a.business_id AND r.id=a.resource_id
        WHERE a.business_id=$1 AND a.status='booked' AND a.ends_at > now() AND (a.starts_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date
          AND ($3::bigint IS NULL OR r.location_id=$3)
        ORDER BY a.starts_at LIMIT 6`, values),
      // Each person's day: bookings, done, busy now, the next one; their sales and commission today.
      repo.all(repo.pool, `SELECT r.id,r.name,r.role_label,
          count(a.id) FILTER (WHERE a.status<>'cancelled')::int AS booked,
          count(a.id) FILTER (WHERE a.status='completed')::int AS done,
          bool_or(a.status='booked' AND a.starts_at <= now() AND a.ends_at > now()) AS busy,
          min(a.starts_at) FILTER (WHERE a.status='booked' AND a.starts_at > now()) AS next_at,
          (SELECT COALESCE(sum(dl.net),0) FROM salon_line_staff ls JOIN business_document_lines dl ON dl.business_id=ls.business_id AND dl.id=ls.line_id
             JOIN business_documents d ON d.business_id=dl.business_id AND d.id=dl.document_id
             WHERE ls.business_id=r.business_id AND ls.resource_id=r.id AND (d.created_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date) AS sales,
          (SELECT COALESCE(sum(ls.commission_amount),0) FROM salon_line_staff ls JOIN business_documents d ON d.business_id=ls.business_id AND d.id=ls.document_id
             WHERE ls.business_id=r.business_id AND ls.resource_id=r.id AND (d.created_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date) AS commission
        FROM business_resources r
        LEFT JOIN business_appointments a ON a.business_id=r.business_id AND a.resource_id=r.id AND (a.starts_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date
        WHERE r.business_id=$1 AND r.active AND ($3::bigint IS NULL OR r.location_id=$3)
        GROUP BY r.id ORDER BY count(a.id) FILTER (WHERE a.status<>'cancelled') DESC, r.name LIMIT 12`, values),
    ]);
    result.appointments = {
      next,
      people: people.map((p) => ({ ...p, sales: seesSales ? money(p.sales) : null, commission: seesCommission ? money(p.commission) : null })),
    };
  }
  return result;
}

module.exports = { overview };
