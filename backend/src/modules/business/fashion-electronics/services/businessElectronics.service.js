const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');

// Electronics & mobiles: models, the serial / IMEI register and warranties.
//
// A serial-numbered unit's life — received from a supplier, moved between
// locations, sold to a customer, returned, sent back, written off — is read
// from the stock ledger (lots and movements), so it can never disagree with
// stock. The database (migration 1791420000001) refuses a serial in stock at
// two places, an invalid IMEI on first receipt and one number under two items.
// A warranty is registered from a sold serial line: start (the sale date by
// default), months and terms from the model, the customer's name and phone.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const hashOf = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function requireModule(business, code, name) {
  if (!business.modules.includes(code)) fail(`${name} is not switched on for this business. An owner can turn it on in Settings › Business tools.`, 403);
}
// The last ten digits of a phone number: "+91 98450-12345" → "9845012345".
// A phone's last 10 digits, to find a warranty or a repair by; null when no phone was given.
function phoneDigits(phone, name = 'Phone') {
  if (phone === undefined || phone === null || !String(phone).trim()) return null;
  const digits = String(phone).replace(/\D/g, '').slice(-10);
  if (digits.length < 6) fail(`${name} needs at least 6 digits`);
  return digits;
}
function luhn(code) {
  if (!/^\d{15}$/.test(code)) return false;
  const total = [...code].reduce((sum, c, i) => {
    let digit = Number(c);
    if (i % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    return sum + digit;
  }, 0);
  return total % 10 === 0;
}

// --- Models ------------------------------------------------------------------

async function saveModel(business, user, skuId, body) {
  await access.require(business, 'catalog.edit');
  requireModule(business, 'serials', 'Serial / IMEI numbers');
  const serialKind = v.requiredEnum(body.serialKind ?? 'serial', 'Serial kind', ['imei', 'serial']);
  const months = core.decimal(body.warrantyMonths ?? 0, 'Warranty months', 0, 0, 120);
  return repo.transaction(async (db) => {
    const sku = await repo.one(db, 'SELECT id,label,tracking FROM catalog_skus WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(skuId, 'Item')]);
    if (!sku) fail('Item not found', 404);
    if (sku.tracking !== 'serial') fail('Only serial-numbered items have a model record');
    // The brand's helpline (printed on the warranty card) is kept when not sent.
    const current = await repo.one(db, 'SELECT helpline FROM electronics_models WHERE business_id=$1 AND sku_id=$2', [business.id, sku.id]);
    const helpline = body.helpline === undefined ? current?.helpline || null : v.optionalString(body.helpline, 'Brand helpline', 60);
    const row = await repo.one(db, `INSERT INTO electronics_models(business_id,sku_id,model_number,serial_kind,warranty_months,warranty_terms,updated_by,updated_at,helpline)
      VALUES($1,$2,$3,$4,$5,$6,$7,now(),$8) ON CONFLICT(business_id,sku_id) DO UPDATE SET model_number=EXCLUDED.model_number,serial_kind=EXCLUDED.serial_kind,
      warranty_months=EXCLUDED.warranty_months,warranty_terms=EXCLUDED.warranty_terms,updated_by=EXCLUDED.updated_by,updated_at=now(),helpline=EXCLUDED.helpline RETURNING *`,
    [business.id, sku.id, v.optionalString(body.modelNumber, 'Model number', 60), serialKind, months, v.optionalString(body.warrantyTerms, 'Warranty terms', 1000), user.id, helpline]);
    await repo.audit(db, business.id, user.id, 'electronics.model_saved', sku.id, { serialKind, warrantyMonths: months });
    return row;
  });
}

// --- Serial / IMEI register --------------------------------------------------------

// One row per serial-numbered unit the business has ever received, with
// where it is now. Also used (filtered) by the lookups below.
const serialSql = `WITH units AS (
    SELECT l.business_id,l.sku_id,l.lot_code AS serial,
      max(l.id) FILTER (WHERE l.quantity > 0) AS stock_lot_id,
      max(l.location_id) FILTER (WHERE l.quantity > 0) AS stock_location_id,
      max(l.unit_cost) AS unit_cost
    FROM business_stock_lots l JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
    WHERE l.business_id=$1 AND s.tracking='serial' AND l.lot_code<>'' GROUP BY l.business_id,l.sku_id,l.lot_code)
  SELECT u.sku_id,u.serial,u.unit_cost,s.label,s.code,p.brand,m.model_number,COALESCE(m.serial_kind,'serial') AS serial_kind,d2.imei2,d2.note,
    first_in.created_at AS received_at,first_in.document_no AS received_no,first_in.contact_name AS supplier_name,
    CASE WHEN u.stock_lot_id IS NOT NULL THEN 'in_stock'
      WHEN last_move.transfer_id IS NOT NULL AND last_move.quantity < 0 THEN 'in_transit'
      WHEN last_move.return_id IS NOT NULL AND last_doc.kind='purchase' THEN 'returned_to_supplier'
      WHEN last_move.document_id IS NOT NULL AND last_doc.kind='sale' AND last_move.quantity < 0 THEN 'sold'
      WHEN last_move.adjustment_id IS NOT NULL THEN 'written_off'
      ELSE 'out_of_stock' END AS status,
    COALESCE(u.stock_location_id,CASE WHEN last_move.transfer_id IS NOT NULL THEN tr.to_location_id ELSE last_lot.location_id END) AS location_id,
    loc.name AS location_name,tr.transfer_no,
    CASE WHEN last_doc.kind='sale' AND last_move.return_id IS NULL THEN last_doc.document_no END AS sold_no,
    CASE WHEN last_doc.kind='sale' AND last_move.return_id IS NULL THEN last_doc.created_at END AS sold_at,
    CASE WHEN last_doc.kind='sale' AND last_move.return_id IS NULL THEN last_doc.contact_name END AS customer_name,
    CASE WHEN last_doc.kind='sale' AND last_move.return_id IS NULL THEN last_doc.contact_id END AS customer_id,
    w.id AS warranty_id,w.ends_on AS warranty_ends_on,last_move.created_at AS last_moved_at,
    CASE WHEN u.stock_lot_id IS NOT NULL THEN (now()::date - first_in.created_at::date) END AS days_in_stock,
    CASE WHEN u.stock_lot_id IS NULL OR first_in.created_at IS NULL THEN NULL WHEN now()::date - first_in.created_at::date <= 30 THEN '0_30'
      WHEN now()::date - first_in.created_at::date <= 60 THEN '31_60' ELSE '60_plus' END AS age_bucket,
    EXISTS (SELECT 1 FROM electronics_faulty_units f WHERE f.business_id=u.business_id AND f.sku_id=u.sku_id AND f.serial=u.serial AND f.status='awaiting_supplier') AS faulty
  FROM units u
  JOIN catalog_skus s ON s.business_id=u.business_id AND s.id=u.sku_id
  JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
  LEFT JOIN electronics_models m ON m.business_id=u.business_id AND m.sku_id=u.sku_id
  LEFT JOIN electronics_serial_details d2 ON d2.business_id=u.business_id AND d2.sku_id=u.sku_id AND d2.serial=u.serial
  LEFT JOIN LATERAL (SELECT mv.*,l.location_id FROM business_stock_movements mv JOIN business_stock_lots l ON l.business_id=mv.business_id AND l.id=mv.lot_id
    WHERE l.business_id=u.business_id AND l.sku_id=u.sku_id AND l.lot_code=u.serial ORDER BY mv.id DESC LIMIT 1) last_move ON true
  LEFT JOIN business_stock_lots last_lot ON last_lot.business_id=u.business_id AND last_lot.id=last_move.lot_id
  LEFT JOIN business_documents last_doc ON last_doc.business_id=u.business_id AND last_doc.id=last_move.document_id
  LEFT JOIN business_stock_transfers tr ON tr.business_id=u.business_id AND tr.id=last_move.transfer_id
  LEFT JOIN LATERAL (SELECT d.created_at,d.document_no,d.contact_name FROM business_stock_movements mv
    JOIN business_stock_lots l ON l.business_id=mv.business_id AND l.id=mv.lot_id
    JOIN business_documents d ON d.business_id=mv.business_id AND d.id=mv.document_id
    WHERE l.business_id=u.business_id AND l.sku_id=u.sku_id AND l.lot_code=u.serial AND d.kind='purchase' AND mv.return_id IS NULL
    ORDER BY mv.id LIMIT 1) first_in ON true
  LEFT JOIN business_locations loc ON loc.business_id=u.business_id
    AND loc.id=COALESCE(u.stock_location_id,CASE WHEN last_move.transfer_id IS NOT NULL THEN tr.to_location_id ELSE last_lot.location_id END)
  LEFT JOIN LATERAL (SELECT id,ends_on FROM electronics_warranties x WHERE x.business_id=u.business_id AND x.sku_id=u.sku_id AND x.serial=u.serial
    AND x.status='active' ORDER BY x.id DESC LIMIT 1) w ON true`;

// Everything that happened to one unit, oldest first: receipts, transfers,
// sales, returns, corrections, warranties and repairs.
async function serialHistory(business, query) {
  await access.require(business, 'inventory.view');
  requireModule(business, 'serials', 'Serial / IMEI numbers');
  const serial = v.requiredString(query.serial, 'Serial / IMEI', 100);
  const skuId = query.skuId ? id(query.skuId, 'Item') : null;
  const units = await repo.all(repo.pool, `SELECT * FROM (${serialSql}) x WHERE (x.serial=$2 OR x.imei2=$2) AND ($3::bigint IS NULL OR x.sku_id=$3)`, [business.id, serial, skuId]);
  if (!units.length) fail('No unit with this serial / IMEI has been received here', 404);
  const unit = units[0];
  const movements = await repo.all(repo.pool, `SELECT mv.id,mv.quantity,mv.balance_after,mv.created_at,loc.name AS location_name,
      CASE WHEN mv.return_id IS NOT NULL THEN d.kind||'_return' WHEN mv.document_id IS NOT NULL THEN d.kind WHEN mv.transfer_id IS NOT NULL THEN 'transfer'
        WHEN a.count_id IS NOT NULL THEN 'count' ELSE 'correction' END AS source,
      COALESCE(r.return_no,d.document_no,t.transfer_no) AS source_no,d.contact_name,a.reason,
      t.from_location_id,t.to_location_id,fl.name AS from_name,tl.name AS to_name,t.status AS transfer_status
    FROM business_stock_movements mv
    JOIN business_stock_lots l ON l.business_id=mv.business_id AND l.id=mv.lot_id
    JOIN business_locations loc ON loc.business_id=l.business_id AND loc.id=l.location_id
    LEFT JOIN business_documents d ON d.business_id=mv.business_id AND d.id=mv.document_id
    LEFT JOIN business_returns r ON r.business_id=mv.business_id AND r.id=mv.return_id
    LEFT JOIN business_stock_transfers t ON t.business_id=mv.business_id AND t.id=mv.transfer_id
    LEFT JOIN business_locations fl ON fl.business_id=t.business_id AND fl.id=t.from_location_id
    LEFT JOIN business_locations tl ON tl.business_id=t.business_id AND tl.id=t.to_location_id
    LEFT JOIN business_stock_adjustments a ON a.business_id=mv.business_id AND a.id=mv.adjustment_id
    WHERE l.business_id=$1 AND l.sku_id=$2 AND l.lot_code=$3 ORDER BY mv.id`, [business.id, unit.sku_id, unit.serial]);
  const warranties = business.modules.includes('warranties') && access.can(business, 'warranties.view')
    ? await repo.all(repo.pool, `SELECT id,document_id,starts_on,ends_on,months,status,customer_name,customer_phone,created_at FROM electronics_warranties
        WHERE business_id=$1 AND sku_id=$2 AND serial=$3 ORDER BY id`, [business.id, unit.sku_id, unit.serial]) : [];
  const repairs = business.modules.includes('repairs') && access.can(business, 'repairs.view')
    ? await repo.all(repo.pool, `SELECT id,job_no,status,problem,created_at,delivered_at FROM electronics_repair_jobs WHERE business_id=$1 AND serial=$2 ORDER BY id`, [business.id, unit.serial]) : [];
  return { unit, others: units.slice(1), movements, warranties, repairs };
}

// A second IMEI (dual-SIM phones) and a note for one unit.
async function saveSerialDetails(business, user, body) {
  await access.require(business, 'inventory.edit');
  requireModule(business, 'serials', 'Serial / IMEI numbers');
  const skuId = id(body.skuId, 'Item');
  const serial = v.requiredString(body.serial, 'Serial / IMEI', 100);
  const imei2 = v.optionalString(body.imei2, 'Second IMEI', 15);
  if (imei2 && !luhn(imei2)) fail('The second IMEI is not valid: an IMEI has 15 digits and its last digit is a check digit');
  if (imei2 && imei2 === serial) fail('The second IMEI is the same as the first');
  return repo.transaction(async (db) => {
    const lot = await repo.one(db, `SELECT l.id FROM business_stock_lots l JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
      WHERE l.business_id=$1 AND l.sku_id=$2 AND l.lot_code=$3 AND s.tracking='serial' LIMIT 1`, [business.id, skuId, serial]);
    if (!lot) fail('No unit with this serial / IMEI has been received here', 404);
    if (imei2) {
      const clash = await repo.one(db, `SELECT 1 FROM business_stock_lots WHERE business_id=$1 AND lot_code=$2
        UNION ALL SELECT 1 FROM electronics_serial_details WHERE business_id=$1 AND imei2=$2 AND NOT (sku_id=$3 AND serial=$4) LIMIT 1`, [business.id, imei2, skuId, serial]);
      if (clash) fail(`${imei2} is already recorded on another unit`, 409);
    }
    const row = await repo.one(db, `INSERT INTO electronics_serial_details(business_id,sku_id,serial,imei2,note,updated_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(business_id,sku_id,serial) DO UPDATE SET imei2=EXCLUDED.imei2,note=EXCLUDED.note,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
    [business.id, skuId, serial, imei2, v.optionalString(body.note, 'Note', 300), user.id]);
    await repo.audit(db, business.id, user.id, 'electronics.serial_details_saved', skuId, { serial, imei2 });
    return row;
  });
}

// --- Warranties ---------------------------------------------------------------------

// The state a warranty is in today.
const warrantyState = `CASE WHEN w.status='cancelled' THEN 'cancelled'
    WHEN COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=w.business_id AND rl.line_id=w.line_id),0) >= dl.quantity THEN 'returned'
    WHEN w.ends_on < (now() AT TIME ZONE b.timezone)::date THEN 'expired'
    WHEN w.starts_on > (now() AT TIME ZONE b.timezone)::date THEN 'not_started'
    WHEN w.ends_on <= (now() AT TIME ZONE b.timezone)::date + 30 THEN 'expiring'
    ELSE 'active' END`;
const warrantySql = `SELECT w.*,${warrantyState} AS state,d.document_no,d.created_at AS sold_at,s.code AS sku_code,m.model_number,m.helpline,
    (dl.net + dl.tax) AS line_value,
    d2.imei2,u.name AS created_by_name,
    (w.ends_on - (now() AT TIME ZONE b.timezone)::date) AS days_left
  FROM electronics_warranties w JOIN businesses b ON b.id=w.business_id
  JOIN business_documents d ON d.business_id=w.business_id AND d.id=w.document_id
  JOIN business_document_lines dl ON dl.business_id=w.business_id AND dl.id=w.line_id
  JOIN catalog_skus s ON s.business_id=w.business_id AND s.id=w.sku_id
  LEFT JOIN electronics_models m ON m.business_id=w.business_id AND m.sku_id=w.sku_id
  LEFT JOIN electronics_serial_details d2 ON d2.business_id=w.business_id AND d2.sku_id=w.sku_id AND d2.serial=w.serial
  JOIN users u ON u.id=w.created_by WHERE w.business_id=$1`;

// Sold serial lines that can still be registered: no live warranty, not all returned.
const eligibleSql = `SELECT dl.id AS line_id,dl.document_id,dl.sku_id,dl.label,dl.lot_code AS serial,d.document_no,d.created_at AS sold_at,
    ((d.created_at AT TIME ZONE b.timezone)::date)::text AS sold_on,d.contact_id,d.contact_name,c.phone AS contact_phone,
    COALESCE(m.warranty_months,0) AS warranty_months,m.warranty_terms,m.model_number
  FROM business_document_lines dl JOIN businesses b ON b.id=dl.business_id
  JOIN business_documents d ON d.business_id=dl.business_id AND d.id=dl.document_id AND d.kind='sale'
  JOIN catalog_skus s ON s.business_id=dl.business_id AND s.id=dl.sku_id AND s.tracking='serial'
  LEFT JOIN business_contacts c ON c.business_id=d.business_id AND c.id=d.contact_id
  LEFT JOIN electronics_models m ON m.business_id=dl.business_id AND m.sku_id=dl.sku_id
  WHERE dl.business_id=$1 AND dl.lot_code<>''
    AND NOT EXISTS (SELECT 1 FROM electronics_warranties w WHERE w.business_id=dl.business_id AND w.line_id=dl.id AND w.status='active')
    AND COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=dl.business_id AND rl.line_id=dl.id),0) < dl.quantity`;

async function eligible(business, query) {
  await access.require(business, 'warranties.create');
  const q = typeof query.q === 'string' && query.q.trim() ? `%${query.q.trim().slice(0, 60).replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  return repo.all(repo.pool, `${eligibleSql} AND ($2::text IS NULL OR concat_ws(' ',d.document_no,dl.lot_code,dl.label,d.contact_name,c.phone) ILIKE $2)
    ORDER BY d.id DESC,dl.id LIMIT 50`, [business.id, q]);
}

async function register(business, user, body) {
  await access.require(business, 'warranties.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const lineId = id(body.lineId, 'Sold item');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM electronics_warranties WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for a different warranty', 409);
      return old;
    }
    const line = await repo.one(db, `SELECT dl.*,d.kind,d.contact_id,d.contact_name,d.created_at AS sold_at,s.tracking,c.phone AS contact_phone,
        ((d.created_at AT TIME ZONE $3)::date)::text AS sold_on,((now() AT TIME ZONE $3)::date)::text AS today,
        COALESCE(m.warranty_months,0) AS default_months,m.warranty_terms,
        COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=dl.business_id AND rl.line_id=dl.id),0) AS returned
      FROM business_document_lines dl JOIN business_documents d ON d.business_id=dl.business_id AND d.id=dl.document_id
      JOIN catalog_skus s ON s.business_id=dl.business_id AND s.id=dl.sku_id
      LEFT JOIN business_contacts c ON c.business_id=d.business_id AND c.id=d.contact_id
      LEFT JOIN electronics_models m ON m.business_id=dl.business_id AND m.sku_id=dl.sku_id
      WHERE dl.business_id=$1 AND dl.id=$2`, [business.id, lineId, business.timezone]);
    if (!line || line.kind !== 'sale') fail('Sold item not found', 404);
    if (line.tracking !== 'serial' || !line.lot_code) fail('A warranty is registered against a serial / IMEI number; this item has none');
    if (Number(line.returned) >= Number(line.quantity)) fail('This unit was returned, so it has no warranty', 409);
    const live = await repo.one(db, "SELECT id FROM electronics_warranties WHERE business_id=$1 AND line_id=$2 AND status='active'", [business.id, line.id]);
    if (live) fail(`The warranty for ${line.lot_code} is already registered`, 409);
    const startsOn = body.startsOn ? core.dateText(body.startsOn, 'Warranty start') : line.sold_on;
    if (startsOn < line.sold_on) fail(`The warranty cannot start before the sale (${line.sold_on})`);
    if (startsOn > line.today) fail('The warranty cannot start in the future');
    const months = body.months === undefined || body.months === null || body.months === '' ? line.default_months : core.decimal(body.months, 'Warranty months', 0, 1, 120);
    if (!months) fail('Set the warranty months (this model has none set)');
    const customerName = v.optionalString(body.customerName, 'Customer name', 150) || line.contact_name;
    if (!customerName) fail('Enter the customer\'s name');
    // The phone is optional: the serial and the bill find a warranty too.
    const customerPhone = v.optionalString(body.customerPhone, 'Customer phone', 30) || line.contact_phone || null;
    const terms = body.terms === undefined ? line.warranty_terms : v.optionalString(body.terms, 'Warranty terms', 1000);
    const row = await repo.one(db, `INSERT INTO electronics_warranties(business_id,document_id,line_id,sku_id,serial,item_label,contact_id,customer_name,customer_phone,phone_digits,
        starts_on,ends_on,months,terms,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,($11::date + make_interval(months => $12::int) - interval '1 day')::date,$12,$13,$14,$15,$16) RETURNING *`,
    [business.id, line.document_id, line.id, line.sku_id, line.lot_code, line.label, line.contact_id, customerName, customerPhone, phoneDigits(customerPhone, 'Customer phone'),
      startsOn, months, terms, requestKey, hash, user.id]);
    await repo.audit(db, business.id, user.id, 'warranty.registered', row.id, { serial: row.serial, documentId: row.document_id, endsOn: row.ends_on });
    await repo.event(db, business.id, user.id, 'warranty.registered', 'warranty', row.id, { serial: row.serial, skuId: row.sku_id, documentId: row.document_id, startsOn: row.starts_on, endsOn: row.ends_on });
    return row;
  });
}

async function cancel(business, user, warrantyId, body) {
  await access.require(business, 'warranties.cancel');
  const reason = v.requiredString(body.reason, 'Reason', 300);
  return repo.transaction(async (db) => {
    const row = await repo.one(db, `UPDATE electronics_warranties SET status='cancelled',cancel_reason=$3,cancelled_by=$4,cancelled_at=now()
      WHERE business_id=$1 AND id=$2 AND status='active' RETURNING *`, [business.id, id(warrantyId, 'Warranty'), reason, user.id]);
    if (!row) fail('Active warranty not found', 404);
    await repo.audit(db, business.id, user.id, 'warranty.cancelled', row.id, { reason });
    await repo.event(db, business.id, user.id, 'warranty.cancelled', 'warranty', row.id, { serial: row.serial, reason });
    return row;
  });
}

async function warrantyDetail(business, warrantyId) {
  await access.require(business, 'warranties.view');
  const row = await repo.one(repo.pool, `${warrantySql} AND w.id=$2`, [business.id, id(warrantyId, 'Warranty')]);
  if (!row) fail('Warranty not found', 404);
  const seller = await repo.one(repo.pool, `SELECT display_name,legal_name,gstin,address_line1,address_line2,city,postal_code,phone,email,receipt_footer
    FROM business_settings WHERE business_id=$1`, [business.id]);
  return { ...row, seller };
}

// Find warranties, sold units and repairs by IMEI / serial or phone number.
async function lookup(business, query) {
  await access.require(business, 'warranties.view');
  const text = v.requiredString(query.q, 'IMEI, serial or phone', 100);
  if (text.length < 4) fail('Type at least 4 characters of the IMEI, serial or phone number');
  const digits = text.replace(/\D/g, '');
  const phone = digits.length >= 6 ? digits.slice(-10) : null;
  const warranties = await repo.all(repo.pool, `${warrantySql} AND (w.serial=$2 OR d2.imei2=$2 OR ($3::text IS NOT NULL AND w.phone_digits=$3)) ORDER BY w.id DESC LIMIT 50`, [business.id, text, phone]);
  const unregistered = access.can(business, 'warranties.create')
    ? await repo.all(repo.pool, `${eligibleSql} AND (dl.lot_code=$2 OR EXISTS (SELECT 1 FROM electronics_serial_details x WHERE x.business_id=dl.business_id AND x.sku_id=dl.sku_id AND x.serial=dl.lot_code AND x.imei2=$2)
        OR ($3::text IS NOT NULL AND right(regexp_replace(COALESCE(c.phone,''),'\\D','','g'),10)=$3)) ORDER BY d.id DESC LIMIT 20`, [business.id, text, phone]) : [];
  const repairs = business.modules.includes('repairs') && access.can(business, 'repairs.view')
    ? await repo.all(repo.pool, `SELECT id,job_no,status,device,serial,customer_name,customer_phone,problem,created_at,delivered_at,under_warranty FROM electronics_repair_jobs
        WHERE business_id=$1 AND (serial=$2 OR ($3::text IS NOT NULL AND phone_digits=$3)) ORDER BY id DESC LIMIT 20`, [business.id, text, phone]) : [];
  return { query: text, warranties, unregistered, repairs };
}

const lists = {
  'electronics-models': { sql: `SELECT s.id,s.id AS sku_id,s.label,s.code,s.active,p.brand,m.model_number,COALESCE(m.serial_kind,'serial') AS serial_kind,
      COALESCE(m.warranty_months,0) AS warranty_months,m.warranty_terms,m.helpline,
      COALESCE((SELECT sum(quantity) FROM business_stock_lots l WHERE l.business_id=s.business_id AND l.sku_id=s.id),0) AS in_stock
    FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    LEFT JOIN electronics_models m ON m.business_id=s.business_id AND m.sku_id=s.id
    WHERE s.business_id=$1 AND s.tracking='serial'`, search: ['label', 'code', 'brand', 'model_number'], filters: { active: 'active' }, order: 'label,id' },
  serials: { sql: serialSql, search: ['serial', 'imei2', 'label', 'code', 'model_number', 'customer_name', 'sold_no', 'received_no', 'location_name'],
    filters: { status: 'status', sku: 'sku_id', location: 'location_id', age: 'age_bucket', faulty: 'faulty' }, order: 'last_moved_at DESC NULLS LAST,serial' },
  warranties: { sql: warrantySql, search: ['serial', 'imei2', 'customer_name', 'customer_phone', 'item_label', 'document_no'], date: 'created_at',
    filters: { state: 'state', sku: 'sku_id' }, order: 'id DESC' },
};

// A sale of serial-numbered units registers each unit's warranty at once:
// the model's months and terms, from the day of the sale,
// to the customer on the bill (or the walk-in's name, and phone if given, at
// the counter). Inside the sale's own transaction. A unit whose model has no
// warranty, or a sale with no name, is left for Warranties › Register (it
// shows there as sold without a warranty).
async function registerOnSale(db, business, user, sale, lines, { contact, buyer }) {
  const name = contact?.name || buyer?.name || null;
  const phone = contact?.phone || buyer?.phone || null;
  const raw = String(phone ?? '').replace(/\D/g, '').slice(-10);
  const digits = raw.length >= 6 ? raw : null;
  if (!name) return [];
  const registered = [];
  for (const line of lines) {
    if (line.sku.tracking !== 'serial' || !line.lotCode || !line.id) continue;
    const model = await repo.one(db, 'SELECT warranty_months,warranty_terms FROM electronics_models WHERE business_id=$1 AND sku_id=$2', [business.id, line.sku.id]);
    if (!model || !Number(model.warranty_months)) continue;
    const source = { documentId: sale.id, lineId: line.id, serial: line.lotCode };
    const key = crypto.createHash('sha256').update(`${sale.request_key}:warranty:${line.id}`).digest('hex');
    const requestKey = `${key.slice(0, 8)}-${key.slice(8, 12)}-5${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
    const row = await repo.one(db, `INSERT INTO electronics_warranties(business_id,document_id,line_id,sku_id,serial,item_label,contact_id,customer_name,customer_phone,phone_digits,
        starts_on,ends_on,months,terms,request_key,request_hash,created_by)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,d.day,(d.day + make_interval(months => $11::int) - interval '1 day')::date,$11,$12,$13,$14,$15
      FROM (SELECT (now() AT TIME ZONE $16)::date AS day) d RETURNING *`,
    [business.id, sale.id, line.id, line.sku.id, line.lotCode, line.sku.label, contact?.id || null, name, phone, digits,
      Number(model.warranty_months), model.warranty_terms, requestKey, hashOf(source), user.id, business.timezone]);
    await repo.audit(db, business.id, user.id, 'warranty.registered', row.id, { serial: row.serial, documentId: row.document_id, endsOn: row.ends_on, withSale: true });
    await repo.event(db, business.id, user.id, 'warranty.registered', 'warranty', row.id, { serial: row.serial, skuId: row.sku_id, documentId: row.document_id, startsOn: row.starts_on, endsOn: row.ends_on });
    registered.push({ id: row.id, serial: row.serial, ends_on: row.ends_on, months: row.months });
  }
  return registered;
}

module.exports = { saveModel, serialHistory, saveSerialDetails, eligible, register, registerOnSale, cancel, warrantyDetail, lookup, lists, phoneDigits, requireModule, luhn };
