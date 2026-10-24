const pool = require('../../../../config/database');

async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
async function one(db, sql, values = []) { return (await db.query(sql, values)).rows[0]; }
async function all(db, sql, values = []) { return (await db.query(sql, values)).rows; }
async function audit(db, businessId, actorId, action, entityId, details = {}) {
  await db.query('INSERT INTO business_audit(business_id,actor_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)',
    [businessId, actorId, action, entityId, JSON.stringify(details)]);
}
// The outbox row for a money, stock or appointment change. Always called with
// the transaction's own client, so the event commits or rolls back with it.
async function event(db, businessId, actorId, kind, entityType, entityId, payload = {}) {
  await db.query(`INSERT INTO business_events(business_id,kind,entity_type,entity_id,payload,actor_id)
    VALUES($1,$2,$3,$4,$5,$6)`, [businessId, kind, entityType, entityId, JSON.stringify(payload), actorId]);
}

// The platform catalogue (modules and permissions) only changes with a
// migration, which needs a restart, so it is read once per process.
let catalogue = null;
async function platformCatalogue() {
  if (!catalogue) {
    const [modules, permissions, templates] = await Promise.all([
      pool.query('SELECT code,name,description,kind,sort_order,feature_group FROM platform_modules ORDER BY sort_order'),
      pool.query('SELECT code,module_code,action,name,sort_order FROM business_permissions ORDER BY sort_order'),
      pool.query('SELECT code,name,description,full_access FROM business_role_templates ORDER BY sort_order'),
    ]);
    catalogue = { modules: modules.rows, permissions: permissions.rows, templates: templates.rows };
  }
  return catalogue;
}

const capabilitiesSql = `COALESCE((SELECT json_agg(capability ORDER BY capability) FROM business_capabilities WHERE business_id=b.id),'[]')`;
const list = async (userId) => (await pool.query(`
 SELECT b.id,b.name,b.code,b.business_type,b.legacy_restaurant_id,b.status,b.currency,b.timezone,
  CASE rf.format WHEN 'cafe' THEN 'Café' WHEN 'bakery' THEN 'Bakery' WHEN 'cloud_kitchen' THEN 'Cloud kitchen' ELSE t.name END AS type_name,rf.format AS restaurant_format,
  m.role_id,r.name AS role_name,r.full_access,m.last_opened_at,${capabilitiesSql} AS capabilities
 FROM businesses b JOIN business_types t ON t.code=b.business_type LEFT JOIN restaurants rf ON rf.id=b.legacy_restaurant_id
 JOIN business_memberships m ON m.business_id=b.id
 JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id
 WHERE m.user_id=$1 AND m.active AND b.status='active'
 ORDER BY b.name`, [userId])).rows;

// Membership, role, permissions and enabled modules in one statement: what
// the server checks on every business request.
// member_location_id: the one location this person works at (NULL = all);
// member_department_id: the one department whose products and stock they handle (NULL = all).
const access = (id, userId) => one(pool, `SELECT b.*,t.name AS type_name,m.role_id,r.name AS role_name,r.full_access,
 ${capabilitiesSql} AS capabilities,m.location_id AS member_location_id,m.department_id AS member_department_id,
 (SELECT name FROM business_departments WHERE business_id=b.id AND id=m.department_id) AS member_department_name,
 (SELECT name FROM business_locations WHERE business_id=b.id AND id=m.location_id) AS member_location_name,
 COALESCE((SELECT json_agg(id ORDER BY id) FROM business_locations WHERE business_id=b.id AND active),'[]') AS active_location_ids,
 CASE WHEN r.full_access THEN (SELECT json_agg(code ORDER BY code) FROM business_permissions)
  ELSE COALESCE((SELECT json_agg(permission_code ORDER BY permission_code) FROM business_role_permissions
   WHERE business_id=r.business_id AND role_id=r.id),'[]') END AS permissions
 FROM businesses b JOIN business_types t ON t.code=b.business_type
 JOIN business_memberships m ON m.business_id=b.id AND m.user_id=$2 AND m.active
 JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.active
 WHERE b.id=$1 AND b.status='active'`, [id, userId]);

const markOpened = (businessId, userId) => pool.query(
  'UPDATE business_memberships SET last_opened_at=now() WHERE business_id=$1 AND user_id=$2 AND active', [businessId, userId]);

// The money a contact owes (customers) or is owed (suppliers): opening
// balance plus, per document, total - returns - payments + refunds, less the
// part of the customer's collections not yet applied to a bill (their
// advance; see "Shared receivables" in docs/BUSINESS_PLATFORM_DATA_MODEL.md).
// A supplier's payments not yet applied to a receipt are an advance the
// same way (business_supplier_payments). A bounced cheque receipt no longer
// counts, and its bank charge is owed. An advance handed back
// (business_collection_refunds) is added back.
const contactBalanceSql = (alias) => `(${alias}.opening_balance + COALESCE((SELECT sum(d.total
   -COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0)
   -COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0)
   +COALESCE((SELECT sum(amount) FROM business_refunds f WHERE f.business_id=d.business_id AND f.document_id=d.id),0))
   FROM business_documents d WHERE d.business_id=${alias}.business_id AND d.contact_id=${alias}.id),0)
   -COALESCE((SELECT sum(k.amount) FROM business_collections k WHERE k.business_id=${alias}.business_id AND k.contact_id=${alias}.id
     AND NOT EXISTS (SELECT 1 FROM business_collection_cheques q WHERE q.business_id=k.business_id AND q.collection_id=k.id AND q.status='bounced')),0)
   +COALESCE((SELECT sum(p.amount) FROM business_payments p JOIN business_collections k ON k.business_id=p.business_id AND k.id=p.collection_id
     WHERE k.business_id=${alias}.business_id AND k.contact_id=${alias}.id),0)
   +COALESCE((SELECT sum(q.bounce_charge) FROM business_collection_cheques q WHERE q.business_id=${alias}.business_id AND q.contact_id=${alias}.id AND q.status='bounced'),0)
   -COALESCE((SELECT sum(k.amount) FROM business_supplier_payments k WHERE k.business_id=${alias}.business_id AND k.contact_id=${alias}.id),0)
   +COALESCE((SELECT sum(f.amount) FROM business_collection_refunds f WHERE f.business_id=${alias}.business_id AND f.contact_id=${alias}.id),0)
   +COALESCE((SELECT sum(p.amount) FROM business_payments p JOIN business_supplier_payments k ON k.business_id=p.business_id AND k.id=p.supplier_payment_id
     WHERE k.business_id=${alias}.business_id AND k.contact_id=${alias}.id),0))`;

const documentTotalsSql = `COALESCE((SELECT SUM(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0) AS paid
    ,COALESCE((SELECT SUM(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0) AS returned
    ,COALESCE((SELECT SUM(amount) FROM business_refunds r WHERE r.business_id=d.business_id AND r.document_id=d.id),0) AS refunded`;

// The only dynamic SQL pieces come from this fixed registry: each list's base
// query (always filtered by $1 = business), the columns its search box looks
// in, the timestamp its date range applies to, the filters it accepts and its
// order. Values are always bound parameters.
const lists = {
  members: { sql: `SELECT m.user_id AS id,m.role_id,r.name AS role_name,r.full_access,m.active,m.last_opened_at,m.created_at,u.name,u.email,
    m.location_id,l.name AS location_name,m.department_id,dep.name AS department_name
    FROM business_memberships m JOIN users u ON u.id=m.user_id JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id
    LEFT JOIN business_locations l ON l.business_id=m.business_id AND l.id=m.location_id
    LEFT JOIN business_departments dep ON dep.business_id=m.business_id AND dep.id=m.department_id WHERE m.business_id=$1`,
  search: ['name', 'email', 'role_name', 'location_name'], filters: { role: 'role_id', location: 'location_id' }, order: 'full_access DESC,name' },
  roles: { sql: `SELECT r.*,(SELECT count(*)::int FROM business_memberships m WHERE m.business_id=r.business_id AND m.role_id=r.id AND m.active) AS member_count,
    CASE WHEN r.full_access THEN (SELECT count(*)::int FROM business_permissions) ELSE (SELECT count(*)::int FROM business_role_permissions p WHERE p.business_id=r.business_id AND p.role_id=r.id) END AS permission_count,
    CASE WHEN r.full_access THEN (SELECT json_agg(code) FROM business_permissions) ELSE COALESCE((SELECT json_agg(permission_code) FROM business_role_permissions p WHERE p.business_id=r.business_id AND p.role_id=r.id),'[]') END AS permissions
    FROM business_roles r WHERE r.business_id=$1`, search: ['name', 'description'], filters: { active: 'active' }, order: 'full_access DESC,template_code IS NULL,id' },
  pricing: { sql: `SELECT r.*,s.label,s.code AS sku_code,s.unit,c.name AS contact_name FROM business_price_rules r
    JOIN catalog_skus s ON s.business_id=r.business_id AND s.id=r.sku_id
    LEFT JOIN business_contacts c ON c.business_id=r.business_id AND c.id=r.contact_id WHERE r.business_id=$1`,
  search: ['label', 'sku_code', 'contact_name'], order: 'id DESC' },
  catalog: { sql: `SELECT s.*,p.name AS product_name,COALESCE(cat.name,p.category) AS category,p.category_id,p.brand,p.kind,cat.department_id,
    t.name AS tax_rate_name,u.name AS unit_name,u.decimals AS unit_decimals,
    CASE WHEN s.is_kit THEN COALESCE((SELECT min(floor(COALESCE((SELECT sum(l.quantity) FROM business_stock_lots l WHERE l.business_id=k.business_id AND l.sku_id=k.component_sku_id),0)/k.quantity))
        FROM catalog_kit_components k WHERE k.business_id=s.business_id AND k.kit_sku_id=s.id),0)
      ELSE COALESCE((SELECT SUM(quantity) FROM business_stock_lots l WHERE l.business_id=s.business_id AND l.sku_id=s.id),0) END AS stock,
    COALESCE((SELECT json_agg(json_build_object('id',x.id,'unit_code',x.unit_code,'quantity_in_base',x.quantity_in_base) ORDER BY x.quantity_in_base)
      FROM catalog_sku_units x WHERE x.business_id=s.business_id AND x.sku_id=s.id AND x.active),'[]') AS pack_sizes
    FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    LEFT JOIN catalog_categories cat ON cat.business_id=p.business_id AND cat.id=p.category_id
    LEFT JOIN business_tax_rates t ON t.business_id=s.business_id AND t.id=s.tax_rate_id
    LEFT JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit WHERE s.business_id=$1`,
  search: ['label', 'code', 'barcode', 'product_name', 'category', 'brand', 'shelf_location'], filters: { category: 'category_id', kind: 'kind', active: 'active', kit: 'is_kit', department: 'department_id' }, order: 'id DESC' },
  categories: { sql: `WITH RECURSIVE tree AS (
      SELECT c.*,c.name::text AS path,1 AS depth FROM catalog_categories c WHERE c.business_id=$1 AND c.parent_id IS NULL
      UNION ALL SELECT c.*,tree.path||' › '||c.name,tree.depth+1 FROM catalog_categories c JOIN tree ON c.business_id=tree.business_id AND c.parent_id=tree.id)
    SELECT tree.*,(SELECT count(*)::int FROM catalog_products p WHERE p.business_id=tree.business_id AND p.category_id=tree.id) AS product_count,
      (SELECT name FROM catalog_categories pc WHERE pc.business_id=tree.business_id AND pc.id=tree.parent_id) AS parent_name FROM tree`,
  search: ['path'], filters: { active: 'active' }, order: 'path' },
  units: { sql: `SELECT u.*,(SELECT count(*)::int FROM catalog_skus s WHERE s.business_id=u.business_id AND s.unit=u.code) AS sku_count
    FROM business_units u WHERE u.business_id=$1`, search: ['code', 'name', 'kind'], order: "kind,base_unit_code IS NOT NULL,code" },
  'pack-sizes': { sql: `SELECT x.*,s.label,s.code AS sku_code,s.unit AS base_unit FROM catalog_sku_units x
    JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.sku_id WHERE x.business_id=$1`,
  search: ['label', 'sku_code', 'unit_code'], filters: { sku: 'sku_id' }, order: 'label,quantity_in_base' },
  'tax-rates': { sql: `SELECT t.*,(SELECT count(*)::int FROM catalog_skus s WHERE s.business_id=t.business_id AND s.tax_rate_id=t.id) AS sku_count
    FROM business_tax_rates t WHERE t.business_id=$1`, search: ['name'], filters: { active: 'active' }, order: 'active DESC,rate,name' },
  'number-series': { sql: `SELECT n.*,l.name AS location_name,l.code AS location_code FROM business_number_series n
    JOIN business_locations l ON l.business_id=n.business_id AND l.id=n.location_id WHERE n.business_id=$1`,
  search: ['prefix', 'location_name', 'document_kind'], filters: { kind: 'document_kind', location: 'location_id' }, order: 'fiscal_year DESC,location_name,document_kind' },
  contacts: { sql: `SELECT c.*,${contactBalanceSql('c')} AS balance FROM business_contacts c WHERE c.business_id=$1`,
    search: ['name', 'phone', 'email', 'gstin', 'pan'], filters: { kind: 'kind', active: 'active' }, order: 'id DESC' },
  locations: { sql: 'SELECT * FROM business_locations WHERE business_id=$1', search: ['name', 'code'], filters: { active: 'active' }, order: 'id' },
  resources: { sql: 'SELECT r.*,l.name AS location_name FROM business_resources r JOIN business_locations l ON l.business_id=r.business_id AND l.id=r.location_id WHERE r.business_id=$1',
    search: ['name', 'role_label', 'location_name'], filters: { location: 'location_id' }, order: 'id DESC' },
  // The item's biggest pack (to show cases), and filters
  // for batches with stock and batches expiring soon (the business's
  // near_expiry_days, Business settings › Rules).
  stock: { sql: `SELECT l.*,s.label,s.code,s.unit,s.reorder_level,s.tracking,s.shelf_location,loc.name AS location_name,
    (SELECT c.department_id FROM catalog_products p JOIN catalog_categories c ON c.business_id=p.business_id AND c.id=p.category_id
      WHERE p.business_id=s.business_id AND p.id=s.product_id) AS department_id,
    (l.expires_on IS NOT NULL AND l.expires_on < (now() AT TIME ZONE b.timezone)::date) AS expired,
    (l.quantity > 0) AS in_stock,
    (l.quantity > 0 AND l.expires_on IS NOT NULL AND l.expires_on <= (now() AT TIME ZONE b.timezone)::date
      + COALESCE((SELECT near_expiry_days FROM business_settings bs WHERE bs.business_id=l.business_id),30)) AS expiring,
    (SELECT u.unit_code FROM catalog_sku_units u WHERE u.business_id=s.business_id AND u.sku_id=s.id AND u.active ORDER BY u.quantity_in_base DESC LIMIT 1) AS pack_unit,
    (SELECT u.quantity_in_base FROM catalog_sku_units u WHERE u.business_id=s.business_id AND u.sku_id=s.id AND u.active ORDER BY u.quantity_in_base DESC LIMIT 1) AS pack_factor
    FROM business_stock_lots l JOIN businesses b ON b.id=l.business_id
    JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
    JOIN business_locations loc ON loc.business_id=l.business_id AND loc.id=l.location_id WHERE l.business_id=$1`,
  search: ['label', 'code', 'lot_code', 'location_name', 'shelf_location'], filters: { location: 'location_id', sku: 'sku_id', in_stock: 'in_stock', expiring: 'expiring', department: 'department_id' }, order: 'id DESC' },
  // Searchable by the serial / IMEI numbers and the supplier's bill number on it too.
  // Wholesale: an invoice raised by dispatching a sales order
  // carries the order, its salesperson and route, and the delivery state.
  documents: { sql: `SELECT x.*,(x.contact_id IS NULL AND x.kind='sale' AND x.total-x.returned-x.paid+x.refunded>0) AS walk_in_due,
    (x.total-x.returned-x.paid+x.refunded>0) AS unpaid FROM (
    SELECT d.*,l.name AS location_name,${documentTotalsSql},
    (SELECT string_agg(DISTINCT dl.lot_code,' ') FROM business_document_lines dl WHERE dl.business_id=d.business_id AND dl.document_id=d.id AND dl.lot_code<>'') AS lot_codes,
    o.order_no,o.salesperson_id,sp.name AS salesperson_name,o.route_id,r.name AS route_name,w.delivery_status,
    CASE WHEN w.id IS NULL THEN 'counter' ELSE 'order' END AS source,
    -- Who billed it and how it was paid (one method, or mixed).
    cu.name AS created_by_name,
    (SELECT CASE WHEN count(DISTINCT p.method)>1 THEN 'mixed' ELSE min(p.method) END FROM business_payments p
      WHERE p.business_id=d.business_id AND p.document_id=d.id) AS paid_by
    FROM business_documents d JOIN business_locations l ON l.business_id=d.business_id AND l.id=d.location_id
    LEFT JOIN users cu ON cu.id=d.created_by
    LEFT JOIN wholesale_dispatches w ON w.business_id=d.business_id AND w.document_id=d.id
    LEFT JOIN wholesale_orders o ON o.business_id=w.business_id AND o.id=w.order_id
    LEFT JOIN wholesale_salespeople sp ON sp.business_id=o.business_id AND sp.id=o.salesperson_id
    LEFT JOIN wholesale_routes r ON r.business_id=o.business_id AND r.id=o.route_id
    WHERE d.business_id=$1) x`,
  search: ['document_no', 'contact_name', 'notes', 'supplier_bill_no', 'lot_codes', 'order_no', 'created_by_name'], date: 'created_at',
  filters: { kind: 'kind', location: 'location_id', contact: 'contact_id', walk_in_due: 'walk_in_due', unpaid: 'unpaid',
    salesperson: 'salesperson_id', route: 'route_id', delivery: 'delivery_status', source: 'source',
    created_by: 'created_by', paid_by: 'paid_by' }, order: 'id DESC' },
  movements: { sql: `SELECT m.*,s.label,s.unit,l.lot_code,l.location_id,loc.name AS location_name,
    COALESCE(d.document_no,t.transfer_no,sc.count_no,'Correction') AS source_no,
    CASE WHEN m.return_id IS NOT NULL THEN 'return' WHEN m.document_id IS NOT NULL THEN d.kind WHEN m.transfer_id IS NOT NULL THEN 'transfer'
      WHEN a.count_id IS NOT NULL THEN 'count' ELSE 'correction' END AS source,a.reason
    FROM business_stock_movements m
    JOIN business_stock_lots l ON l.business_id=m.business_id AND l.id=m.lot_id
    JOIN business_locations loc ON loc.business_id=l.business_id AND loc.id=l.location_id
    JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
    LEFT JOIN business_documents d ON d.business_id=m.business_id AND d.id=m.document_id
    LEFT JOIN business_stock_transfers t ON t.business_id=m.business_id AND t.id=m.transfer_id
    LEFT JOIN business_stock_adjustments a ON a.business_id=m.business_id AND a.id=m.adjustment_id
    LEFT JOIN business_stock_counts sc ON sc.business_id=a.business_id AND sc.id=a.count_id
    WHERE m.business_id=$1`,
  search: ['label', 'lot_code', 'source_no', 'reason', 'location_name'], date: 'created_at', filters: { location: 'location_id', source: 'source' },
  // In time order: a back-dated posting sits on its own date.
  order: 'created_at DESC,id DESC' },
  transfers: { sql: `SELECT t.*,f.name AS from_location_name,d.name AS to_location_name,
    (SELECT count(*)::int FROM business_stock_transfer_lines x WHERE x.business_id=t.business_id AND x.transfer_id=t.id) AS line_count,
    (SELECT COALESCE(sum(x.quantity*x.unit_cost),0)::numeric(16,2) FROM business_stock_transfer_lines x WHERE x.business_id=t.business_id AND x.transfer_id=t.id) AS value
    FROM business_stock_transfers t
    JOIN business_locations f ON f.business_id=t.business_id AND f.id=t.from_location_id
    JOIN business_locations d ON d.business_id=t.business_id AND d.id=t.to_location_id WHERE t.business_id=$1`,
  search: ['transfer_no', 'from_location_name', 'to_location_name', 'notes'], date: 'created_at',
  filters: { status: 'status', location: { any: ['from_location_id', 'to_location_id'] } }, order: 'id DESC' },
  counts: { sql: `SELECT c.*,l.name AS location_name,
    (SELECT count(*)::int FROM business_stock_count_lines x WHERE x.business_id=c.business_id AND x.count_id=c.id) AS line_count,
    (SELECT count(*)::int FROM business_stock_count_lines x WHERE x.business_id=c.business_id AND x.count_id=c.id AND x.counted_quantity IS NOT NULL) AS counted_count,
    (SELECT count(*)::int FROM business_stock_count_lines x WHERE x.business_id=c.business_id AND x.count_id=c.id AND x.adjustment_id IS NOT NULL) AS corrected_count
    FROM business_stock_counts c JOIN business_locations l ON l.business_id=c.business_id AND l.id=c.location_id WHERE c.business_id=$1`,
  search: ['count_no', 'location_name', 'notes'], date: 'created_at', filters: { status: 'status', location: 'location_id' }, order: 'id DESC' },
  appointments: { sql: `SELECT a.*,r.name AS resource_name,r.location_id,c.name AS contact_name,s.label AS service_name
    FROM business_appointments a JOIN business_resources r ON r.business_id=a.business_id AND r.id=a.resource_id
    JOIN business_contacts c ON c.business_id=a.business_id AND c.id=a.contact_id
    JOIN catalog_skus s ON s.business_id=a.business_id AND s.id=a.sku_id WHERE a.business_id=$1`,
  search: ['contact_name', 'service_name', 'resource_name'], date: 'starts_at', filters: { status: 'status', location: 'location_id' }, order: 'starts_at DESC,id DESC' },
  audit: { sql: `SELECT a.id,a.action,a.entity_id,a.created_at,a.actor_id,a.details,u.name AS actor_name FROM business_audit a
    JOIN users u ON u.id=a.actor_id WHERE a.business_id=$1`, search: ['action', 'actor_name'], date: 'created_at', order: 'id DESC' },
};
const escapeLike = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`);
// options: { limit, offset, search, from, to, timezone, filters: { name: value } }
async function page(businessId, kind, limit, offset, options = {}) {
  const spec = lists[kind];
  if (!spec) throw new Error('Unknown business list');
  const values = [businessId, limit, offset];
  const where = [];
  if (options.search) {
    values.push(`%${escapeLike(options.search)}%`);
    where.push(`concat_ws(' ',${spec.search.map((c) => `records.${c}`).join(',')}) ILIKE $${values.length}`);
  }
  if (spec.date && (options.from || options.to)) {
    values.push(options.timezone || 'Asia/Kolkata');
    const tz = values.length;
    if (options.from) { values.push(options.from); where.push(`(records.${spec.date} AT TIME ZONE $${tz})::date >= $${values.length}::date`); }
    if (options.to) { values.push(options.to); where.push(`(records.${spec.date} AT TIME ZONE $${tz})::date <= $${values.length}::date`); }
  }
  for (const [name, value] of Object.entries(options.filters || {})) {
    const column = spec.filters?.[name];
    if (!column || value === undefined || value === null) continue;
    // A filter is one column, or { any: [columns] } (a transfer is a branch's
    // when it leaves or reaches it), with orNull: an empty column means every
    // branch (a salon-wide holiday).
    const columns = typeof column === 'string' ? [column] : column.any;
    values.push(Array.isArray(value) ? value : String(value));
    const test = (c) => (Array.isArray(value) ? `records.${c}::text = ANY($${values.length}::text[])` : `records.${c}::text = $${values.length}`);
    const tests = columns.map(test);
    if (column.orNull) tests.push(...columns.map((c) => `records.${c} IS NULL`));
    where.push(tests.length > 1 ? `(${tests.join(' OR ')})` : tests[0]);
  }
  // Single statement: page and count see the same database snapshot, including empty pages.
  return one(pool, `WITH records AS (${spec.sql}), matched AS (SELECT * FROM records ${where.length ? `WHERE ${where.join(' AND ')}` : ''})
   SELECT (SELECT count(*)::int FROM matched) AS total,
   COALESCE((SELECT json_agg(p) FROM (SELECT * FROM matched ORDER BY ${spec.order} LIMIT $2 OFFSET $3) p),'[]') AS items`, values);
}
// Type modules register their own lists (same rules: $1 = business, bound values).
function addLists(extra) {
  for (const [name, spec] of Object.entries(extra)) {
    if (lists[name] && lists[name] !== spec) throw new Error(`Business list ${name} is already registered`);
    lists[name] = spec;
  }
}
const listFilters = (kind) => Object.keys(lists[kind]?.filters || {});

// locationId: a branch (tied staff, or picked in the top bar) narrows the
// sales, stock and day figures; customers' balances stay business-wide.
async function summary(businessId, locationId = null) {
  return one(pool, `WITH tz AS (SELECT timezone, (now() AT TIME ZONE timezone)::date AS today FROM businesses WHERE id=$1),
   sales_events AS (
     SELECT (d.created_at AT TIME ZONE tz.timezone)::date AS day, tz.today, d.total AS amount FROM business_documents d, tz
     WHERE d.business_id=$1 AND d.kind='sale' AND d.created_at >= date_trunc('month', now()) - interval '2 days' AND ($2::bigint IS NULL OR d.location_id=$2)
     UNION ALL
     SELECT (r.created_at AT TIME ZONE tz.timezone)::date, tz.today, -r.total FROM business_returns r
     JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id CROSS JOIN tz
     WHERE r.business_id=$1 AND d.kind='sale' AND r.created_at >= date_trunc('month', now()) - interval '2 days' AND ($2::bigint IS NULL OR d.location_id=$2)),
   -- Every customer's balance as Udhaar / Outstanding shows it: opening
   -- balance and bills, less what was paid and their advances.
   balances AS (SELECT ${contactBalanceSql('c')} AS balance FROM business_contacts c WHERE c.business_id=$1 AND c.kind='customer')
  SELECT
   (SELECT count(*)::int FROM catalog_skus WHERE business_id=$1 AND active) AS skus,
   (SELECT count(*)::int FROM business_contacts WHERE business_id=$1 AND active) AS contacts,
   (SELECT count(*)::int FROM business_locations WHERE business_id=$1 AND active) AS locations,
   (SELECT count(*)::int FROM business_appointments a JOIN businesses b ON b.id=a.business_id
     JOIN business_resources res ON res.business_id=a.business_id AND res.id=a.resource_id WHERE a.business_id=$1 AND a.status='booked'
     AND (a.starts_at AT TIME ZONE b.timezone)::date = (now() AT TIME ZONE b.timezone)::date AND ($2::bigint IS NULL OR res.location_id=$2)) AS appointments_today,
   (SELECT count(*)::int FROM business_appointments a JOIN business_resources res ON res.business_id=a.business_id AND res.id=a.resource_id
     WHERE a.business_id=$1 AND a.status='booked' AND a.starts_at>=now() AND ($2::bigint IS NULL OR res.location_id=$2)) AS appointments_upcoming,
   (SELECT count(*)::int FROM business_stock_transfers WHERE business_id=$1 AND status='in_transit'
     AND ($2::bigint IS NULL OR from_location_id=$2 OR to_location_id=$2)) AS transfers_in_transit,
   (SELECT count(*)::int FROM business_stock_counts WHERE business_id=$1 AND status='open' AND ($2::bigint IS NULL OR location_id=$2)) AS counts_open,
   (SELECT count(*)::int FROM (SELECT s.id FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
     WHERE s.business_id=$1 AND s.active AND p.kind='goods' AND s.reorder_level>0
     AND COALESCE((SELECT sum(quantity) FROM business_stock_lots l WHERE l.business_id=s.business_id AND l.sku_id=s.id AND ($2::bigint IS NULL OR l.location_id=$2)),0) <= s.reorder_level) low) AS low_stock,
   (SELECT count(*)::int FROM business_stock_lots l JOIN businesses b ON b.id=l.business_id WHERE l.business_id=$1 AND l.quantity>0 AND ($2::bigint IS NULL OR l.location_id=$2)
     AND l.expires_on IS NOT NULL AND l.expires_on <= (now() AT TIME ZONE b.timezone)::date
       + COALESCE((SELECT near_expiry_days FROM business_settings WHERE business_id=$1),30)) AS expiring_soon,
   -- Net of returns, each on its own posting date (as Reports count them):
   -- an even exchange adds nothing, a return today lowers today's sales.
   (SELECT COALESCE(sum(amount) FILTER (WHERE day = today),0) FROM sales_events) AS sales_today,
   (SELECT COALESCE(sum(amount) FILTER (WHERE date_trunc('month', day) = date_trunc('month', today)),0) FROM sales_events) AS sales_month,
   COALESCE((SELECT sum(total) FROM business_documents WHERE business_id=$1 AND kind='sale' AND ($2::bigint IS NULL OR location_id=$2)),0)
   -COALESCE((SELECT sum(r.total) FROM business_returns r JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id WHERE r.business_id=$1 AND d.kind='sale'
     AND ($2::bigint IS NULL OR d.location_id=$2)),0) AS sales,
   (SELECT COALESCE(sum(balance) FILTER (WHERE balance>0),0) FROM balances) AS receivables_owed,
   (SELECT COALESCE(-sum(balance) FILTER (WHERE balance<0),0) FROM balances) AS receivables_advances,
   (SELECT COALESCE(sum(balance),0) FROM balances) AS receivables,
   -- Unpaid bills with no customer named (walk-ins): not anyone's udhaar, shown apart.
   COALESCE((SELECT sum(GREATEST(0,d.total
   -COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0)
   -COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0)
   +COALESCE((SELECT sum(amount) FROM business_refunds r WHERE r.business_id=d.business_id AND r.document_id=d.id),0)))
   FROM business_documents d WHERE d.business_id=$1 AND kind='sale' AND d.contact_id IS NULL),0) AS receivables_walk_in,
   COALESCE((SELECT sum(GREATEST(0,d.total
   -COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0)
   -COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0)
   +COALESCE((SELECT sum(amount) FROM business_refunds r WHERE r.business_id=d.business_id AND r.document_id=d.id),0)))
   FROM business_documents d WHERE d.business_id=$1 AND kind='purchase'),0) AS payables`, [businessId, locationId]);
}
module.exports = { pool, transaction, one, all, audit, event, platformCatalogue, list, access, markOpened, page, listFilters, summary, contactBalanceSql, addLists };
