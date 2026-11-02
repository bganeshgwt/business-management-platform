const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');
const orders = require('./shopOrders.service');

// The online shop's report and its bell (ADMIN_GUIDE.md, the online shop's
// report; the bell is businessNotifications.service.js feed()).

const fail = (message, status = 400) => { throw new AppError(status, message); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Online orders by day (the business's own dates), by how each ended, their
// value, the average minutes to accept and to pack, and the declines and
// cancellations by reason.
async function report(business, { from, to, location } = {}) {
  await access.require(business, 'online_shop.view');
  if (!DATE.test(String(from || '')) || !DATE.test(String(to || ''))) fail('Choose the days to report: from and to');
  if (to < from || Date.parse(to) - Date.parse(from) > 366 * 86400000) fail('Choose up to a year of days');
  const values = [business.id, from, to, business.timezone || 'Asia/Kolkata'];
  let place = '';
  const chosen = location ? v.requiredId(location, 'Location') : business.location_scope;
  if (chosen) { values.push(chosen); place = `AND o.location_id=$${values.length}`; }
  const base = `FROM shop_orders o WHERE o.business_id=$1 AND (o.placed_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date ${place}`;
  const days = await repo.all(repo.pool, `SELECT (o.placed_at AT TIME ZONE $4)::date::text AS day,count(*)::int AS placed,
      count(*) FILTER (WHERE o.accepted_at IS NOT NULL)::int AS accepted,
      count(*) FILTER (WHERE o.status='completed')::int AS completed,
      count(*) FILTER (WHERE o.status='declined' AND o.declined_auto)::int AS declined_auto,
      count(*) FILTER (WHERE o.status='declined' AND NOT o.declined_auto)::int AS declined,
      count(*) FILTER (WHERE o.status='cancelled' AND o.cancelled_by='guest')::int AS cancelled_guest,
      count(*) FILTER (WHERE o.status='cancelled' AND o.cancelled_by='shop')::int AS cancelled_shop,
      count(*) FILTER (WHERE o.status IN ('placed','accepted','packed','ready','out_for_delivery'))::int AS open,
      COALESCE(sum(o.final_total) FILTER (WHERE o.status='completed'),0) AS value,
      round(avg(EXTRACT(EPOCH FROM o.accepted_at-o.placed_at)/60) FILTER (WHERE o.accepted_at IS NOT NULL),1) AS accept_minutes,
      round(avg(EXTRACT(EPOCH FROM o.packed_at-o.accepted_at)/60) FILTER (WHERE o.packed_at IS NOT NULL),1) AS pack_minutes
    ${base} GROUP BY 1 ORDER BY 1 DESC`, values);
  // A reason as people read it: the shop's own words, or what the rule or the customer did.
  const reasons = await repo.all(repo.pool, `SELECT CASE WHEN o.status='declined' THEN 'declined' ELSE 'cancelled' END AS kind,
      CASE WHEN o.status='declined' AND o.declined_auto THEN 'The shop did not respond in time' WHEN o.status='declined' THEN o.decline_reason
        ELSE o.cancel_reason END AS reason,
      CASE WHEN o.status='cancelled' THEN o.cancelled_by END AS by,count(*)::int AS n
    ${base} AND o.status IN ('declined','cancelled') GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 40`, values);
  const totals = days.reduce((sum, day) => {
    for (const key of ['placed', 'accepted', 'completed', 'declined_auto', 'declined', 'cancelled_guest', 'cancelled_shop', 'open']) sum[key] += day[key];
    sum.value += Number(day.value);
    return sum;
  }, { placed: 0, accepted: 0, completed: 0, declined_auto: 0, declined: 0, cancelled_guest: 0, cancelled_shop: 0, open: 0, value: 0 });
  const averages = await repo.one(repo.pool, `SELECT round(avg(EXTRACT(EPOCH FROM o.accepted_at-o.placed_at)/60) FILTER (WHERE o.accepted_at IS NOT NULL),1) AS accept_minutes,
      round(avg(EXTRACT(EPOCH FROM o.packed_at-o.accepted_at)/60) FILTER (WHERE o.packed_at IS NOT NULL),1) AS pack_minutes ${base}`, values);
  return {
    from, to,
    days: days.map((day) => ({ ...day, value: Number(day.value), acceptMinutes: day.accept_minutes === null ? null : Number(day.accept_minutes),
      packMinutes: day.pack_minutes === null ? null : Number(day.pack_minutes) })),
    totals: { ...totals, value: Number(totals.value.toFixed(2)), acceptMinutes: averages.accept_minutes === null ? null : Number(averages.accept_minutes),
      packMinutes: averages.pack_minutes === null ? null : Number(averages.pack_minutes) },
    reasons: reasons.map((row) => ({ kind: row.kind, reason: row.reason, by: row.by, count: row.n })),
  };
}

// The bell: new orders waiting for an answer (a new one is a new alert), and
// the complaints' clocks (a day unacknowledged, a week left to resolve, late).
async function bell(business, base) {
  await orders.expire(business.id);
  const items = [];
  const at = new Date().toISOString();
  const waiting = await repo.one(repo.pool, `SELECT count(*)::int AS n,max(id) AS newest,min(auto_decline_at) AS first_due,
      bool_or(auto_decline_at<now()+interval '10 minutes') AS soon FROM shop_orders WHERE business_id=$1 AND status='placed'
      ${business.location_scope ? 'AND location_id=$2' : ''}`, [business.id, ...(business.location_scope ? [business.location_scope] : [])]);
  if (waiting.n > 0) {
    items.push({ id: `online-orders:${waiting.newest}`, severity: waiting.soon ? 'warning' : 'info', category: 'Online orders',
      title: `${waiting.n} new online ${waiting.n === 1 ? 'order' : 'orders'}`,
      detail: waiting.soon ? 'One is declined by itself within 10 minutes unless it is accepted' : 'Waiting for you to accept or decline',
      at, link: `${base}/online-orders` });
  }
  const complaints = await repo.all(repo.pool, `SELECT id,ticket_no,status,created_at,acknowledge_by,resolve_by,
      (now()-created_at>interval '24 hours') AS day_old,(now()>acknowledge_by) AS ack_late,(now()>resolve_by) AS resolve_late,
      (resolve_by-now()<interval '7 days') AS resolve_soon
    FROM shop_complaints WHERE business_id=$1 AND status<>'resolved' ${business.location_scope ? 'AND location_id=$2' : ''} ORDER BY created_at LIMIT 15`,
  [business.id, ...(business.location_scope ? [business.location_scope] : [])]);
  for (const row of complaints) {
    if (row.status === 'open' && row.day_old) {
      items.push({ id: `complaint:${row.id}:${row.ack_late ? 'late' : 'ack'}`, severity: row.ack_late ? 'critical' : 'warning', category: 'Online orders',
        title: row.ack_late ? `Complaint ${row.ticket_no} is past its 48 hours unacknowledged` : `Complaint ${row.ticket_no} not acknowledged for a day`,
        detail: 'Acknowledge it on Online orders, under Complaints', at: new Date(row.created_at).toISOString(), link: `${base}/online-orders?tab=complaints` });
    } else if (row.status !== 'open' && (row.resolve_late || row.resolve_soon)) {
      items.push({ id: `complaint:${row.id}:${row.resolve_late ? 'overdue' : 'due'}`, severity: row.resolve_late ? 'critical' : 'warning', category: 'Online orders',
        title: row.resolve_late ? `Complaint ${row.ticket_no} is past its month unresolved` : `Complaint ${row.ticket_no} is to be resolved within a week`,
        detail: 'Resolve it on Online orders, under Complaints', at: new Date(row.created_at).toISOString(), link: `${base}/online-orders?tab=complaints` });
    }
  }
  return items;
}

module.exports = { report, bell };
