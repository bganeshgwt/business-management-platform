const repo = require('../repositories/business.repository');
const access = require('./businessAccess.service');
const AppError = require('../../../../utils/AppError');
const { dateText } = require('./business.service');

// Branch comparison (every business type): which location is carrying the
// others? Sales, returns, bills, average bill, purchases, money collected and
// stock value per location for a period, with each one's share of net sales.
// Every location is shown (a branch picked in the top bar does not narrow
// it); a person tied to one location sees only theirs.

const fail = (message, status = 400) => { throw new AppError(status, message); };

async function compare(business, query) {
  await access.require(business, 'reports.view');
  await access.require(business, 'sales.view');
  const today = (await repo.one(repo.pool, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone])).day;
  const to = query.to ? dateText(query.to, 'To date') : today;
  const from = query.from ? dateText(query.from, 'From date') : `${to.slice(0, 8)}01`;
  if (to < from) fail('The end date is before the start date');
  const only = business.location_tied ? business.location_scope : null;
  const rows = await repo.all(repo.pool, `
    WITH period AS (SELECT $2::date AS from_day, $3::date AS to_day, $4::text AS tz),
    docs AS (
      SELECT d.* FROM business_documents d, period
      WHERE d.business_id=$1 AND (d.created_at AT TIME ZONE period.tz)::date BETWEEN period.from_day AND period.to_day)
    SELECT l.id,l.name,l.code,l.active,
      COALESCE((SELECT count(*) FROM docs WHERE docs.location_id=l.id AND docs.kind='sale'),0)::int AS bills,
      COALESCE((SELECT sum(total) FROM docs WHERE docs.location_id=l.id AND docs.kind='sale'),0)::numeric(16,2) AS sales,
      COALESCE((SELECT sum(r.total) FROM business_returns r JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id, period
        WHERE r.business_id=l.business_id AND d.location_id=l.id AND d.kind='sale'
          AND (r.created_at AT TIME ZONE period.tz)::date BETWEEN period.from_day AND period.to_day),0)::numeric(16,2) AS returns,
      COALESCE((SELECT sum(total) FROM docs WHERE docs.location_id=l.id AND docs.kind='purchase'),0)::numeric(16,2) AS purchases,
      COALESCE((SELECT sum(p.amount) FROM business_payments p JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id, period
        WHERE p.business_id=l.business_id AND d.location_id=l.id AND d.kind='sale'
          AND (p.created_at AT TIME ZONE period.tz)::date BETWEEN period.from_day AND period.to_day),0)::numeric(16,2) AS collected,
      COALESCE((SELECT sum(quantity*unit_cost) FROM business_stock_lots s WHERE s.business_id=l.business_id AND s.location_id=l.id AND s.quantity>0),0)::numeric(16,2) AS stock_value
    FROM business_locations l WHERE l.business_id=$1 AND ($5::bigint IS NULL OR l.id=$5) ORDER BY l.id`,
  [business.id, from, to, business.timezone, only]);
  // Closed locations with nothing in the period are left out.
  const shown = rows.filter((r) => r.active || Number(r.bills) || Number(r.purchases) || Number(r.returns) || Number(r.stock_value));
  const paise = (value) => Math.round(Number(value) * 100);
  const totalNet = shown.reduce((sum, r) => sum + paise(r.sales) - paise(r.returns), 0);
  const locations = shown.map((r) => {
    const net = paise(r.sales) - paise(r.returns);
    return {
      ...r,
      net_sales: (net / 100).toFixed(2),
      average_bill: r.bills ? (paise(r.sales) / r.bills / 100).toFixed(2) : '0.00',
      share_percent: totalNet > 0 ? Number(((net / totalNet) * 100).toFixed(1)) : 0,
    };
  });
  const sum = (key) => (locations.reduce((total, r) => total + paise(r[key]), 0) / 100).toFixed(2);
  return {
    from, to, locations,
    totals: { bills: locations.reduce((n, r) => n + r.bills, 0), sales: sum('sales'), returns: sum('returns'), net_sales: sum('net_sales'),
      purchases: sum('purchases'), collected: sum('collected'), stock_value: sum('stock_value') },
  };
}

module.exports = { compare };
