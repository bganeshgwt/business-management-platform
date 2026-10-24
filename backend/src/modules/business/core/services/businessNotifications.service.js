const repo = require('../repositories/business.repository');
const access = require('./businessAccess.service');

// The Business Admin bell: what needs someone's attention in
// one business, worked out from live data when asked — nothing is stored.
// Each alert has a stable id (kind + record), so the browser can remember
// which ones this person has already seen. Only what this person may see is
// included: stock alerts need inventory.view, udhaar needs receivables.view,
// and so on.
//
//   low stock          items at or below their reorder level
//   expiring batches   expired (critical) or within 7 / 30 days
//   overdue udhaar     customers with bills past their due date
//   promises           promised to pay today, or a promise broken
//   repairs            ready to collect, or past the promised date
//   appointments       still to come today
//   licences           running out within 60 days, or run out
//   wholesale overdue  (same overdue query, worded as invoices)

const LIMIT = 15;
// Goods shops call customer credit udhaar and have its screen (businessTypes.js).
const { GOODS_TYPES: RETAIL_WORDS } = require('./businessTypes');
const money = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty = (value, unit) => `${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${unit}`;
const dayWord = (n) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n < 0 ? `${-n} days ago` : `in ${n} days`);

async function feed(business) {
  const has = (module) => business.modules.includes(module);
  const can = (permission) => access.can(business, permission);
  const base = `/business-admin/${business.id}`;
  const goods = RETAIL_WORDS.includes(business.business_type);
  const items = [];
  const nowIso = new Date().toISOString();

  if (has('inventory') && can('inventory.view')) {
    const low = await repo.all(repo.pool, `SELECT s.id,s.label,s.unit,s.reorder_level,
        COALESCE((SELECT sum(quantity) FROM business_stock_lots l WHERE l.business_id=s.business_id AND l.sku_id=s.id),0) AS stock
      FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      WHERE s.business_id=$1 AND s.active AND p.kind='goods' AND s.reorder_level>0
        AND COALESCE((SELECT sum(quantity) FROM business_stock_lots l WHERE l.business_id=s.business_id AND l.sku_id=s.id),0) <= s.reorder_level
      ORDER BY (COALESCE((SELECT sum(quantity) FROM business_stock_lots l WHERE l.business_id=s.business_id AND l.sku_id=s.id),0) > 0), s.label LIMIT $2`, [business.id, LIMIT]);
    for (const row of low) {
      const out = Number(row.stock) <= 0;
      items.push({ id: `low:${row.id}`, severity: out ? 'warning' : 'info', category: 'Stock',
        title: out ? `${row.label} is out of stock` : `${row.label} is running low`,
        detail: out ? `Reorder level ${qty(row.reorder_level, row.unit)}` : `${qty(row.stock, row.unit)} left · reorder at ${qty(row.reorder_level, row.unit)}`,
        at: nowIso, link: `${base}/products` });
    }
  }
  if (has('inventory') && has('batches') && can('inventory.view')) {
    const lots = await repo.all(repo.pool, `WITH today AS (SELECT (now() AT TIME ZONE timezone)::date AS d FROM businesses WHERE id=$1)
      SELECT l.id,s.label,s.unit,l.lot_code,l.expires_on::text AS expires_on,l.quantity,(l.expires_on - today.d) AS days_left,loc.name AS location_name
      FROM business_stock_lots l CROSS JOIN today JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
      JOIN business_locations loc ON loc.business_id=l.business_id AND loc.id=l.location_id
      WHERE l.business_id=$1 AND l.quantity>0 AND l.expires_on IS NOT NULL
        AND l.expires_on <= today.d + COALESCE((SELECT near_expiry_days FROM business_settings WHERE business_id=$1),30)
      ORDER BY l.expires_on,s.label LIMIT $2`, [business.id, LIMIT]);
    for (const lot of lots) {
      const days = Number(lot.days_left);
      items.push({ id: `expiry:${lot.id}:${days < 0 ? 'x' : days <= 7 ? '7' : '30'}`, severity: days < 0 ? 'critical' : days <= 7 ? 'warning' : 'info', category: 'Expiry',
        title: days < 0 ? `${lot.label} has expired` : `${lot.label} expires ${dayWord(days)}`,
        detail: `${qty(lot.quantity, lot.unit)}${lot.lot_code ? ` · batch ${lot.lot_code}` : ''} · ${lot.location_name}`,
        at: `${lot.expires_on}T00:00:00.000Z`, link: `${base}/near-expiry` });
    }
  }
  if (has('receivables') && can('receivables.view')) {
    const overdue = await repo.all(repo.pool, `WITH today AS (SELECT (now() AT TIME ZONE timezone)::date AS d FROM businesses WHERE id=$1),
      open_bills AS (SELECT d.contact_id,d.due_on,d.total
          -COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0)
          -COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0)
          +COALESCE((SELECT sum(amount) FROM business_refunds f WHERE f.business_id=d.business_id AND f.document_id=d.id),0) AS due
        FROM business_documents d CROSS JOIN today WHERE d.business_id=$1 AND d.kind='sale' AND d.contact_id IS NOT NULL AND d.due_on < today.d)
      SELECT c.id,c.name,sum(b.due) AS overdue,min(b.due_on)::text AS oldest,count(*)::int AS bills,(SELECT d FROM today) - min(b.due_on) AS days
      FROM open_bills b JOIN business_contacts c ON c.business_id=$1 AND c.id=b.contact_id
      WHERE b.due > 0.004 GROUP BY c.id,c.name ORDER BY sum(b.due) DESC LIMIT $2`, [business.id, LIMIT]);
    for (const row of overdue) {
      const days = Number(row.days);
      items.push({ id: `overdue:${row.id}:${row.oldest}`, severity: days > 30 ? 'critical' : 'warning', category: goods ? 'Udhaar' : 'Outstanding',
        title: goods ? `${row.name}: ${money(row.overdue)} udhaar overdue` : `${row.name}: ${money(row.overdue)} overdue`,
        detail: `${row.bills} ${row.bills === 1 ? (goods ? 'bill' : 'invoice') : (goods ? 'bills' : 'invoices')} · oldest due ${days} ${days === 1 ? 'day' : 'days'} ago`,
        at: `${row.oldest}T00:00:00.000Z`, link: `${base}/${goods ? 'udhaar' : 'outstanding'}` });
    }
    if (has('sales')) {
      const promises = await repo.all(repo.pool, `WITH today AS (SELECT (now() AT TIME ZONE timezone)::date AS d FROM businesses WHERE id=$1),
        latest AS (SELECT DISTINCT ON (contact_id) id,contact_id,promised_on FROM retail_credit_reminders WHERE business_id=$1 ORDER BY contact_id,created_at DESC,id DESC)
        SELECT l.id,c.name,l.promised_on::text AS promised_on,(l.promised_on - today.d) AS days,${repo.contactBalanceSql('c')} AS balance
        FROM latest l CROSS JOIN today JOIN business_contacts c ON c.business_id=$1 AND c.id=l.contact_id
        WHERE l.promised_on IS NOT NULL AND l.promised_on <= today.d AND ${repo.contactBalanceSql('c')} > 0
        ORDER BY l.promised_on DESC LIMIT $2`, [business.id, LIMIT]);
      for (const row of promises) {
        const today = Number(row.days) === 0;
        items.push({ id: `promise:${row.id}`, severity: today ? 'info' : 'warning', category: goods ? 'Udhaar' : 'Outstanding',
          title: today ? `${row.name} promised to pay today` : `${row.name} broke a promise to pay`,
          detail: `Owes ${money(row.balance)}${today ? '' : ` · promised ${dayWord(Number(row.days))}`}`,
          at: `${row.promised_on}T00:00:00.000Z`, link: `${base}/${goods ? 'udhaar' : 'outstanding'}` });
      }
    }
  }
  if (has('repairs') && can('repairs.view')) {
    const jobs = await repo.all(repo.pool, `WITH today AS (SELECT (now() AT TIME ZONE timezone)::date AS d FROM businesses WHERE id=$1)
      SELECT j.id,j.job_no,j.status,j.device,j.customer_name,j.promised_on::text AS promised_on,j.updated_at
      FROM electronics_repair_jobs j CROSS JOIN today
      WHERE j.business_id=$1 AND (j.status='ready' OR (j.status NOT IN ('ready','delivered','cancelled') AND j.promised_on < today.d))
      ORDER BY (j.status='ready') DESC,j.promised_on NULLS LAST LIMIT $2`, [business.id, LIMIT]);
    for (const job of jobs) {
      const ready = job.status === 'ready';
      items.push({ id: `repair:${job.id}:${ready ? 'ready' : 'late'}`, severity: ready ? 'info' : 'warning', category: 'Repairs',
        title: ready ? `${job.job_no} is ready to collect` : `${job.job_no} is past its promised date`,
        detail: [job.device, job.customer_name].filter(Boolean).join(' · '),
        at: new Date(job.updated_at || Date.now()).toISOString(), link: `${base}/repairs/${job.id}` });
    }
  }
  if (has('appointments') && can('appointments.view')) {
    const left = await repo.one(repo.pool, `SELECT count(*)::int AS n, min(starts_at) AS next FROM business_appointments a JOIN businesses b ON b.id=a.business_id
      WHERE a.business_id=$1 AND a.status='booked' AND a.starts_at>=now() AND (a.starts_at AT TIME ZONE b.timezone)::date=(now() AT TIME ZONE b.timezone)::date`, [business.id]);
    if (left.n > 0) {
      items.push({ id: `appointments:${new Date(left.next).toISOString().slice(0, 10)}`, severity: 'info', category: 'Appointments',
        title: `${left.n} ${left.n === 1 ? 'appointment' : 'appointments'} still to come today`,
        detail: `Next at ${new Date(left.next).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: business.timezone || 'Asia/Kolkata' })}`,
        at: new Date(left.next).toISOString(), link: `${base}/${business.business_type === 'salon' ? 'salon-calendar' : 'appointments'}` });
    }
  }
  // Licences & registrations: a licence running out within 60 days (warning), or run out (critical).
  if (has('licences') && can('licences.view')) {
    const licences = require('../../licences/services/businessLicences.service');
    for (const row of await licences.expiring(business, LIMIT)) {
      const days = Number(row.days);
      items.push({ id: `licence:${row.id}:${row.valid_until}:${days < 0 ? 'x' : 'soon'}`, severity: days < 0 ? 'critical' : 'warning', category: 'Licences',
        title: days < 0 ? `${row.name} has run out` : `${row.name} runs out ${dayWord(days)}`,
        detail: `No. ${row.licence_no} · ${row.location_name} · ${days < 0 ? 'ran out' : 'valid until'} ${licences.dateWords(row.valid_until)}`,
        at: `${row.valid_until}T00:00:00.000Z`, link: `${base}/licences` });
    }
  }
  // Tasks & issues (modules/tasks): your overdue tasks, the team's, reviews, serious issues.
  items.push(...await require('../../../tasks/services/notifications').forBusiness(business));
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const item of items) counts[item.severity] += 1;
  return { items, counts, generatedAt: nowIso };
}

module.exports = { feed };
