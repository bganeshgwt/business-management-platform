const repo = require('../repositories/business.repository');
const access = require('./businessAccess.service');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');

// Departments of a store (Clothing, Home, Grocery…). Top-level categories
// belong to one, and their sub-categories follow (businessSetup). A person
// tied to a department (business_memberships.department_id) sees and changes
// products and stock of that department only; billing stays open to every
// item, since a counter sells across departments.

const fail = (message, status = 400) => { throw new AppError(status, message); };

async function list(business) {
  await access.require(business, 'catalog.view');
  return repo.all(repo.pool, `SELECT d.*,
      (SELECT count(*)::int FROM catalog_categories c WHERE c.business_id=d.business_id AND c.department_id=d.id AND c.parent_id IS NULL) AS category_count,
      (SELECT count(*)::int FROM business_memberships m WHERE m.business_id=d.business_id AND m.department_id=d.id AND m.active) AS staff_count
    FROM business_departments d WHERE d.business_id=$1 ORDER BY d.active DESC,lower(d.name)`, [business.id]);
}

async function create(business, user, body) {
  await access.require(business, 'settings.edit');
  const name = v.requiredString(body.name, 'Department name', 80);
  return repo.transaction(async (db) => {
    if (await repo.one(db, 'SELECT id FROM business_departments WHERE business_id=$1 AND lower(name)=lower($2)', [business.id, name])) fail(`There is already a department called ${name}`, 409);
    const row = await repo.one(db, 'INSERT INTO business_departments(business_id,name,created_by) VALUES($1,$2,$3) RETURNING *', [business.id, name, user.id]);
    await repo.audit(db, business.id, user.id, 'department.created', row.id, { name });
    return row;
  });
}

async function update(business, user, departmentId, body) {
  await access.require(business, 'settings.edit');
  const name = v.requiredString(body.name, 'Department name', 80);
  const active = v.requiredBoolean(body.active, 'Active', true);
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM business_departments WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, v.requiredId(departmentId, 'Department')]);
    if (!current) fail('Department not found', 404);
    if (await repo.one(db, 'SELECT id FROM business_departments WHERE business_id=$1 AND lower(name)=lower($2) AND id<>$3', [business.id, name, current.id])) fail(`There is already a department called ${name}`, 409);
    if (!active && current.active) {
      // Switched off only once nobody works in it; its categories keep it for history and reports.
      const staff = await repo.one(db, 'SELECT count(*)::int AS n FROM business_memberships WHERE business_id=$1 AND department_id=$2 AND active', [business.id, current.id]);
      if (staff.n) fail(`${staff.n === 1 ? 'One person works' : `${staff.n} people work`} in ${current.name}. Move them first (Staff & access).`, 409);
    }
    const row = await repo.one(db, 'UPDATE business_departments SET name=$3,active=$4 WHERE business_id=$1 AND id=$2 RETURNING *', [business.id, current.id, name, active]);
    await repo.audit(db, business.id, user.id, 'department.updated', row.id, { name, active });
    return row;
  });
}

// Sales, returns, cost and margin per department over a period (and a row
// for items in no department). Margin is sales less the cost each sold line
// recorded when it left the shelf, both net of returns.
async function report(business, query) {
  await access.require(business, 'reports.view');
  const core = require('./business.service');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: business.timezone }).format(new Date());
  const from = core.dateText(query.from || today, 'Start date');
  const to = core.dateText(query.to || from, 'End date');
  if (to < from || Date.parse(to) - Date.parse(from) > 366 * 86400000) fail('Choose a date range of up to 367 days');
  const location = query.location ? v.requiredId(query.location, 'Location') : null;
  if (location) access.requireLocation(business, location);
  const rows = await repo.all(repo.pool, `WITH lines AS (
      SELECT cat.department_id,dl.net,dl.tax,dl.quantity,d.id AS document_id,dl.quantity*COALESCE(dl.stock_unit_cost,0) AS cost
      FROM business_document_lines dl JOIN business_documents d ON d.business_id=dl.business_id AND d.id=dl.document_id
      JOIN catalog_skus s ON s.business_id=dl.business_id AND s.id=dl.sku_id
      JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      LEFT JOIN catalog_categories cat ON cat.business_id=p.business_id AND cat.id=p.category_id
      WHERE dl.business_id=$1 AND d.kind='sale' AND (d.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
        AND ($5::bigint IS NULL OR d.location_id=$5)),
    returned AS (
      SELECT department_id,sum(net) AS net,sum(cost) AS cost FROM (
        SELECT cat.department_id,rl.net,rl.quantity*COALESCE(dl.stock_unit_cost,0) AS cost
        FROM business_return_lines rl JOIN business_returns r ON r.business_id=rl.business_id AND r.id=rl.return_id
        JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id
        JOIN business_document_lines dl ON dl.business_id=rl.business_id AND dl.id=rl.line_id
        JOIN catalog_skus s ON s.business_id=dl.business_id AND s.id=dl.sku_id
        JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
        LEFT JOIN catalog_categories cat ON cat.business_id=p.business_id AND cat.id=p.category_id
        WHERE rl.business_id=$1 AND d.kind='sale' AND (r.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
          AND ($5::bigint IS NULL OR d.location_id=$5)
        -- Free goods kept on a credit note come off it, in the department of the paid goods they came with.
        UNION ALL SELECT cat.department_id,-k.net,0
        FROM wholesale_free_goods_kept k JOIN business_returns r ON r.business_id=k.business_id AND r.id=k.return_id
        JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id
        JOIN wholesale_order_lines x ON x.business_id=k.business_id AND x.id=k.order_line_id
        JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.sku_id
        JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
        LEFT JOIN catalog_categories cat ON cat.business_id=p.business_id AND cat.id=p.category_id
        WHERE k.business_id=$1 AND (r.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
          AND ($5::bigint IS NULL OR d.location_id=$5)) t
      GROUP BY department_id)
    SELECT dep.id AS department_id,COALESCE(dep.name,'No department') AS department,
      count(DISTINCT l.document_id)::int AS bills,COALESCE(sum(l.net),0)::numeric(16,2) AS net_sales,COALESCE(sum(l.tax),0)::numeric(16,2) AS tax,
      COALESCE(max(rt.net),0)::numeric(16,2) AS returns,(COALESCE(sum(l.cost),0)-COALESCE(max(rt.cost),0))::numeric(16,2) AS cost
    FROM lines l LEFT JOIN business_departments dep ON dep.business_id=$1 AND dep.id=l.department_id
    LEFT JOIN returned rt ON rt.department_id IS NOT DISTINCT FROM l.department_id
    GROUP BY dep.id,dep.name ORDER BY sum(l.net) DESC NULLS LAST`, [business.id, from, to, business.timezone, location]);
  return { from, to, rows: rows.map((r) => {
    const net = Number(r.net_sales) - Number(r.returns);
    const margin = net - Number(r.cost);
    return { ...r, net_after_returns: net.toFixed(2), margin: margin.toFixed(2), margin_percent: net > 0 ? Number(((margin / net) * 100).toFixed(1)) : null };
  }) };
}

module.exports = { list, create, update, report };
