const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./opticalCommon');

// The referral report (module "optical"): for each doctor who referred
// customers (as written on a prescription or a spectacle order, the same name
// in any case or spacing counting as one), in the dates chosen (on the
// business's clock): the spectacle and contact-lens prescriptions recorded for
// their referrals (by the day of the test), the customers, the spectacle
// orders booked (not cancelled) and delivered (by the day booked), and, for
// someone who sees sales, what those orders come to and what their bills came to.

const { fail } = c;
const MAX_DAYS = 366;

// query: { from?, to? } (YYYY-MM-DD; this month so far unless given).
async function report(business, query = {}) {
  c.requireOptical(business);
  await access.require(business, 'optical.view');
  const today = await c.today(repo.pool, business);
  const from = c.given(query.from) ? core.dateText(query.from, 'From date') : `${today.slice(0, 8)}01`;
  const to = c.given(query.to) ? core.dateText(query.to, 'To date') : today;
  if (to < from) fail('The end date is before the start date');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_DAYS) fail(`Choose up to ${MAX_DAYS + 1} days`);
  const money = access.can(business, 'sales.view');
  const rows = await repo.all(repo.pool, `WITH tz AS (SELECT timezone FROM businesses WHERE id=$1),
      rx AS (SELECT lower(regexp_replace(btrim(p.referred_by),'\\s+',' ','g')) AS key,p.referred_by AS name,p.kind,p.contact_id,p.created_at FROM optical_prescriptions p
        WHERE p.business_id=$1 AND p.referred_by IS NOT NULL AND p.examined_on BETWEEN $2::date AND $3::date),
      orders AS (SELECT lower(regexp_replace(btrim(o.referred_by),'\\s+',' ','g')) AS key,o.referred_by AS name,o.status,o.total,o.contact_id,o.created_at,d.total AS billed
        FROM optical_orders o CROSS JOIN tz LEFT JOIN business_documents d ON d.business_id=o.business_id AND d.id=o.document_id
        WHERE o.business_id=$1 AND o.referred_by IS NOT NULL AND (o.created_at AT TIME ZONE tz.timezone)::date BETWEEN $2::date AND $3::date),
      keys AS (SELECT key FROM rx UNION SELECT key FROM orders)
    SELECT k.key,
      COALESCE((SELECT r.name FROM rx r WHERE r.key=k.key ORDER BY r.created_at DESC LIMIT 1),(SELECT o.name FROM orders o WHERE o.key=k.key ORDER BY o.created_at DESC LIMIT 1)) AS doctor,
      (SELECT count(*)::int FROM rx r WHERE r.key=k.key AND r.kind='spectacles') AS prescriptions,
      (SELECT count(*)::int FROM rx r WHERE r.key=k.key AND r.kind='contact_lens') AS contact_lens_prescriptions,
      (SELECT count(DISTINCT x.contact_id)::int FROM (SELECT r.contact_id FROM rx r WHERE r.key=k.key UNION ALL SELECT o.contact_id FROM orders o WHERE o.key=k.key) x) AS customers,
      (SELECT count(*)::int FROM orders o WHERE o.key=k.key AND o.status<>'cancelled') AS orders,
      (SELECT count(*)::int FROM orders o WHERE o.key=k.key AND o.status='delivered') AS delivered,
      (SELECT COALESCE(sum(o.total),0) FROM orders o WHERE o.key=k.key AND o.status<>'cancelled') AS booked_value,
      (SELECT COALESCE(sum(o.billed),0) FROM orders o WHERE o.key=k.key AND o.status='delivered') AS billed
    FROM keys k`, [business.id, from, to]);
  rows.sort((a, b) => b.orders - a.orders || b.prescriptions + b.contact_lens_prescriptions - a.prescriptions - a.contact_lens_prescriptions || a.doctor.localeCompare(b.doctor));
  const paise = (x) => Math.round(Number(x) * 100);
  const sum = (key) => rows.reduce((s, r) => s + Number(r[key]), 0);
  const totals = { doctors: rows.length, prescriptions: sum('prescriptions'), contact_lens_prescriptions: sum('contact_lens_prescriptions'), orders: sum('orders'),
    delivered: sum('delivered'), booked_value: money ? (rows.reduce((s, r) => s + paise(r.booked_value), 0) / 100).toFixed(2) : null,
    billed: money ? (rows.reduce((s, r) => s + paise(r.billed), 0) / 100).toFixed(2) : null };
  return { from, to, money, timezone: business.timezone, totals,
    rows: rows.map(({ key: _key, ...r }) => (money ? r : { ...r, booked_value: null, billed: null })) };
}

module.exports = { report };
