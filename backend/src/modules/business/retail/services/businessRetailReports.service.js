const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const service = require('../../core/services/business.service');

// Retail reports: what sells, what sits on the shelf, what each category
// earns and what the stock is worth. Sales are counted on the day they were
// posted, net of what came back (returns), before GST. Cost is the stock
// cost recorded on each sold line when it left the shelf (weighted average
// of the batch), so a later purchase price never changes past margins.

const fail = (message, status = 400) => { throw new AppError(status, message); };

function period(query) {
  const from = service.dateText(query.from, 'Start date'), to = service.dateText(query.to, 'End date');
  if (to < from) fail('The end date is before the start date');
  if (Date.parse(to) - Date.parse(from) > 366 * 86400000) fail('Choose a period of up to a year');
  return { from, to };
}
const locationOf = (query) => (query.location ? v.requiredId(query.location, 'Location') : null);

// Each sold line in the period, less what came back from it.
const SOLD = `WITH sold AS (
  SELECT l.sku_id,l.quantity-COALESCE(r.quantity,0) AS quantity,l.net-COALESCE(r.net,0) AS net,
    (l.quantity-COALESCE(r.quantity,0))*COALESCE(l.stock_unit_cost,0) AS cost,(l.stock_unit_cost IS NULL) AS no_cost,d.id AS document_id,d.created_at
  FROM business_document_lines l
  JOIN business_documents d ON d.business_id=l.business_id AND d.id=l.document_id AND d.kind='sale'
  LEFT JOIN LATERAL (SELECT sum(rl.quantity) AS quantity,sum(rl.net) AS net FROM business_return_lines rl
    WHERE rl.business_id=l.business_id AND rl.line_id=l.id) r ON true
  WHERE l.business_id=$1 AND (d.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date AND ($5::bigint IS NULL OR d.location_id=$5))`;

async function topSellers(business, query) {
  await access.require(business, 'reports.view');
  await access.require(business, 'sales.view');
  const { from, to } = period(query);
  const rows = await repo.all(repo.pool, `${SOLD}
    SELECT s.id AS sku_id,s.label,s.code,s.unit,COALESCE(cat.name,p.category) AS category,
      sum(sold.quantity) AS quantity,sum(sold.net) AS net,round(sum(sold.cost),2) AS cost,round(sum(sold.net)-sum(sold.cost),2) AS margin,
      count(DISTINCT sold.document_id)::int AS bills,bool_or(sold.no_cost) AS cost_missing
    FROM sold JOIN catalog_skus s ON s.business_id=$1 AND s.id=sold.sku_id
    JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    LEFT JOIN catalog_categories cat ON cat.business_id=p.business_id AND cat.id=p.category_id
    GROUP BY s.id,s.label,s.code,s.unit,cat.name,p.category HAVING sum(sold.quantity)>0
    ORDER BY sum(sold.net) DESC,s.label LIMIT 500`, [business.id, from, to, business.timezone, locationOf(query)]);
  return { from, to, rows };
}

// Items with stock, slowest first: what sold in the last `days` days, when it
// last sold, and how many days the stock would last at that pace.
async function slowMovers(business, query) {
  await access.require(business, 'reports.view');
  await access.require(business, 'inventory.view');
  const days = query.days === undefined ? 30 : Number(query.days);
  if (!Number.isInteger(days) || days < 7 || days > 365) fail('Look back between 7 and 365 days');
  const location = locationOf(query);
  const rows = await repo.all(repo.pool, `WITH b AS (SELECT timezone,(now() AT TIME ZONE timezone)::date AS today FROM businesses WHERE id=$1),
    stock AS (SELECT sku_id,sum(quantity) AS quantity,sum(quantity*unit_cost) AS value FROM business_stock_lots
      WHERE business_id=$1 AND quantity>0 AND ($3::bigint IS NULL OR location_id=$3) GROUP BY sku_id),
    sales AS (SELECT l.sku_id,max(d.created_at) AS last_sold_at,
      sum(l.quantity) FILTER (WHERE (d.created_at AT TIME ZONE b.timezone)::date > b.today-$2::int) AS sold
      FROM business_document_lines l JOIN business_documents d ON d.business_id=l.business_id AND d.id=l.document_id AND d.kind='sale', b
      WHERE l.business_id=$1 AND ($3::bigint IS NULL OR d.location_id=$3) GROUP BY l.sku_id)
    SELECT s.id AS sku_id,s.label,s.code,s.unit,COALESCE(cat.name,p.category) AS category,stock.quantity AS on_hand,round(stock.value,2) AS value,
      COALESCE(sales.sold,0) AS sold,sales.last_sold_at,
      CASE WHEN sales.last_sold_at IS NULL THEN NULL ELSE (b.today-(sales.last_sold_at AT TIME ZONE b.timezone)::date) END AS days_since_sale,
      CASE WHEN COALESCE(sales.sold,0)>0 THEN round(stock.quantity/(sales.sold/$2::numeric)) END AS cover_days
    FROM stock JOIN catalog_skus s ON s.business_id=$1 AND s.id=stock.sku_id
    JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    LEFT JOIN catalog_categories cat ON cat.business_id=p.business_id AND cat.id=p.category_id
    LEFT JOIN sales ON sales.sku_id=s.id CROSS JOIN b
    ORDER BY COALESCE(sales.sold,0)/NULLIF(stock.quantity,0),sales.last_sold_at NULLS FIRST,stock.value DESC LIMIT 500`, [business.id, days, location]);
  return { days, rows };
}

// Sales, cost and margin per category (and its share of the period).
async function categoryMargin(business, query) {
  await access.require(business, 'reports.view');
  await access.require(business, 'sales.view');
  const { from, to } = period(query);
  const rows = await repo.all(repo.pool, `${SOLD},
    paths AS (WITH RECURSIVE tree AS (SELECT c.id,c.name::text AS path FROM catalog_categories c WHERE c.business_id=$1 AND c.parent_id IS NULL
      UNION ALL SELECT c.id,tree.path||' › '||c.name FROM catalog_categories c JOIN tree ON c.business_id=$1 AND c.parent_id=tree.id) SELECT * FROM tree)
    SELECT COALESCE(p.category_id::text,'none') AS key,COALESCE(paths.path,p.category,'No category') AS category,
      count(DISTINCT sold.sku_id)::int AS items,sum(sold.net) AS net,round(sum(sold.cost),2) AS cost,round(sum(sold.net)-sum(sold.cost),2) AS margin,
      CASE WHEN sum(sold.net)>0 THEN round((sum(sold.net)-sum(sold.cost))*100/sum(sold.net),1) END AS margin_percent,bool_or(sold.no_cost) AS cost_missing
    FROM sold JOIN catalog_skus s ON s.business_id=$1 AND s.id=sold.sku_id
    JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    LEFT JOIN paths ON paths.id=p.category_id
    GROUP BY p.category_id,paths.path,p.category HAVING sum(sold.quantity)<>0 OR sum(sold.net)<>0
    ORDER BY sum(sold.net) DESC`, [business.id, from, to, business.timezone, locationOf(query)]);
  return { from, to, rows };
}

// Stock on hand at cost and at today's selling price (before GST).
async function stockValue(business, query) {
  await access.require(business, 'reports.view');
  await access.require(business, 'inventory.view');
  const location = locationOf(query);
  const settings = await repo.one(repo.pool, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]);
  const rows = await repo.all(repo.pool, `SELECT s.id AS sku_id,s.label,s.code,s.unit,COALESCE(cat.name,p.category) AS category,
      sum(l.quantity) AS quantity,round(sum(l.quantity*l.unit_cost),2) AS cost_value,
      round(sum(l.quantity*l.unit_cost)/NULLIF(sum(l.quantity),0),4) AS average_cost,s.price,
      round(sum(l.quantity)*CASE WHEN $3='inclusive' THEN s.price*100/(100+s.tax_rate) ELSE s.price END,2) AS sale_value,
      count(*) FILTER (WHERE l.expires_on IS NOT NULL)::int AS batches
    FROM business_stock_lots l JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
    JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    LEFT JOIN catalog_categories cat ON cat.business_id=p.business_id AND cat.id=p.category_id
    WHERE l.business_id=$1 AND l.quantity>0 AND ($2::bigint IS NULL OR l.location_id=$2)
    GROUP BY s.id,s.label,s.code,s.unit,cat.name,p.category,s.price,s.tax_rate ORDER BY sum(l.quantity*l.unit_cost) DESC LIMIT 1000`,
  [business.id, location, settings?.tax_mode || 'exclusive']);
  return { rows, taxMode: settings?.tax_mode || 'exclusive' };
}

module.exports = { topSellers, slowMovers, categoryMargin, stockValue };
