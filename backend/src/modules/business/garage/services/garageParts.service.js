const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const sheet = require('../../../../utils/sheetImport');
const c = require('./garageCommon');

// Parts that fit a vehicle, and what to offer when one is out of stock
// (module "garage", garages). The shop's own records; no catalogue is shipped.
//
//   fitment      a part (an item kept in stock) fits a make, and optionally a
//                model, variant, fuel, years from and to, and engine code. A
//                vehicle's parts are those whose fitment matches it: a field
//                the fitment leaves empty matches any, and one the vehicle
//                leaves empty is shown as "check" (the vehicle may differ).
//                Typed in, or imported from a CSV file (the shared sheet reader).
//   newer number a part superseded by another (an old number replaced by a new
//                one); the chain is followed both ways.
//   group        parts that do the same job (an interchangeable group).
//   substitutes  for a part, the newer and older numbers and the group's
//                other parts, each with its stock at the location, in stock
//                first: the parts counter and the job card offer them when the
//                part is out of stock.
// Changing fitment, numbers and groups is catalog.edit; reading them is for
// anyone who sells or works on job cards.

const { fail, id } = c;
const READERS = ['garage.view', 'garage.edit', 'sales.create', 'catalog.view'];
const MAX_FITS = 200;

repo.addLists({
  // Every fitment, the newest first, with its part.
  'garage-part-fitments': {
    sql: `SELECT f.id,f.sku_id,s.label,s.code,f.make,f.model,f.variant,f.fuel,f.year_from,f.year_to,f.engine_code,f.created_at,u.name AS created_by_name
      FROM garage_part_fitments f JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id JOIN users u ON u.id=f.created_by
      WHERE f.business_id=$1`,
    search: ['label', 'code', 'make', 'model', 'variant', 'engine_code'], date: 'created_at', filters: { sku: 'sku_id', fuel: 'fuel' }, order: 'id DESC',
  },
  // Every part with a newer number or a group.
  'garage-part-links': {
    sql: `SELECT p.sku_id AS id,p.sku_id,s.label,s.code,p.superseded_by_sku_id,n.label AS superseded_by_label,n.code AS superseded_by_code,p.group_id,g.name AS group_name,
        p.updated_at,u.name AS updated_by_name
      FROM garage_parts p JOIN catalog_skus s ON s.business_id=p.business_id AND s.id=p.sku_id JOIN users u ON u.id=p.updated_by
      LEFT JOIN catalog_skus n ON n.business_id=p.business_id AND n.id=p.superseded_by_sku_id
      LEFT JOIN garage_part_groups g ON g.business_id=p.business_id AND g.id=p.group_id
      WHERE p.business_id=$1 AND (p.superseded_by_sku_id IS NOT NULL OR p.group_id IS NOT NULL)`,
    search: ['label', 'code', 'superseded_by_label', 'superseded_by_code', 'group_name'], filters: { group: 'group_id' }, order: 'label',
  },
});
const listCheck = (business) => c.requireGarage(business);

// --- Reading a fitment ---------------------------------------------------------------------------

const words = (value, name, max) => {
  const text = c.optionalText(value, name, max);
  return text ? text.replace(/\s+/g, ' ') : null;
};
const engineOf = (value) => {
  if (!c.given(value)) return null;
  const text = String(value).toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9-]{2,30}$/.test(text)) fail('Engine code must be 2 to 30 letters, digits or dashes, like K12M');
  return text;
};
const yearOf = (value, name) => {
  if (!c.given(value)) return null;
  const text = String(value).trim();
  if (!/^\d{4}$/.test(text) || Number(text) < 1950 || Number(text) > 2100) fail(`${name} must be a year, like 2019`);
  return Number(text);
};
function readFitment(body) {
  const make = words(body.make, 'Make', 60);
  if (!make) fail('Make is required');
  const fitment = { make, model: words(body.model, 'Model', 60), variant: words(body.variant, 'Variant', 60),
    fuel: v.optionalEnum(c.given(body.fuel) ? body.fuel : null, 'Fuel', c.FUELS, null), yearFrom: yearOf(body.yearFrom, 'Year from'), yearTo: yearOf(body.yearTo, 'Year to'),
    engineCode: engineOf(body.engineCode) };
  if (fitment.yearFrom && fitment.yearTo && fitment.yearTo < fitment.yearFrom) fail('Year to is the same as Year from or later');
  if (fitment.variant && !fitment.model) fail('A variant goes with its model');
  return fitment;
}
const fitmentWords = (f) => [f.make, f.model, f.variant, f.fuel, f.yearFrom || f.yearTo ? `${f.yearFrom || '…'}–${f.yearTo || '…'}` : null, f.engineCode].filter(Boolean).join(' ');

async function goodsItem(db, business, skuId, name = 'Part') {
  const sku = await repo.one(db, `SELECT s.id,s.label,s.code,s.active,p.kind FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    WHERE s.business_id=$1 AND s.id=$2`, [business.id, id(skuId, name)]);
  if (!sku) fail(`${name} not found`, 404);
  if (sku.kind !== 'goods') fail(`${sku.label} is a service: a part is an item kept in stock`);
  return sku;
}

async function insertFitment(db, business, user, sku, f) {
  const same = await repo.one(db, `SELECT id FROM garage_part_fitments WHERE business_id=$1 AND sku_id=$2 AND lower(make)=lower($3) AND lower(COALESCE(model,''))=lower(COALESCE($4,''))
    AND lower(COALESCE(variant,''))=lower(COALESCE($5,'')) AND COALESCE(fuel,'')=COALESCE($6,'') AND COALESCE(year_from,0)=COALESCE($7::int,0) AND COALESCE(year_to,0)=COALESCE($8::int,0)
    AND COALESCE(engine_code,'')=COALESCE($9,'')`, [business.id, sku.id, f.make, f.model, f.variant, f.fuel, f.yearFrom, f.yearTo, f.engineCode]);
  if (same) return null;
  return repo.one(db, `INSERT INTO garage_part_fitments(business_id,sku_id,make,model,variant,fuel,year_from,year_to,engine_code,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [business.id, sku.id, f.make, f.model, f.variant, f.fuel, f.yearFrom, f.yearTo, f.engineCode, user.id]);
}

// body: { skuId, make, model?, variant?, fuel?, yearFrom?, yearTo?, engineCode? }
async function addFitment(business, user, body) {
  c.requireGarage(business);
  await access.require(business, 'catalog.edit');
  const fitment = readFitment(body);
  return repo.transaction(async (db) => {
    const sku = await goodsItem(db, business, body.skuId);
    const row = await insertFitment(db, business, user, sku, fitment);
    if (!row) fail(`${sku.label} already fits ${fitmentWords(fitment)}`, 409);
    await repo.audit(db, business.id, user.id, 'garage_part.fitment_added', sku.id, { part: sku.label, fits: fitmentWords(fitment) });
    return { ...row, label: sku.label, code: sku.code };
  });
}

async function removeFitment(business, user, fitmentId) {
  c.requireGarage(business);
  await access.require(business, 'catalog.edit');
  return repo.transaction(async (db) => {
    const row = await repo.one(db, `SELECT f.*,s.label FROM garage_part_fitments f JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
      WHERE f.business_id=$1 AND f.id=$2 FOR UPDATE OF f`, [business.id, id(fitmentId, 'Fitment')]);
    if (!row) fail('Fitment not found', 404);
    await db.query('DELETE FROM garage_part_fitments WHERE business_id=$1 AND id=$2', [business.id, row.id]);
    await repo.audit(db, business.id, user.id, 'garage_part.fitment_removed', row.sku_id, { part: row.label,
      fits: fitmentWords({ make: row.make, model: row.model, variant: row.variant, fuel: row.fuel, yearFrom: row.year_from, yearTo: row.year_to, engineCode: row.engine_code }) });
    return { id: Number(row.id), removed: true };
  });
}

// --- Newer numbers and groups ------------------------------------------------------------------------

// body: { supersededBySkuId?: id | null, group?: name | null } — what is left out stays.
async function setPart(business, user, skuId, body) {
  c.requireGarage(business);
  await access.require(business, 'catalog.edit');
  const groupName = body.group === undefined ? undefined : words(body.group, 'Group', 80);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const sku = await goodsItem(db, business, skuId);
    const before = await repo.one(db, 'SELECT * FROM garage_parts WHERE business_id=$1 AND sku_id=$2', [business.id, sku.id]);
    let newer = before?.superseded_by_sku_id || null;
    if (body.supersededBySkuId !== undefined) {
      newer = c.given(body.supersededBySkuId) ? (await goodsItem(db, business, body.supersededBySkuId, 'Newer part')).id : null;
      if (newer && Number(newer) === Number(sku.id)) fail('A part is replaced by another part');
    }
    let groupId = before?.group_id || null;
    if (groupName !== undefined) {
      if (!groupName) groupId = null;
      else {
        const found = await repo.one(db, 'SELECT id FROM garage_part_groups WHERE business_id=$1 AND lower(name)=lower($2)', [business.id, groupName]);
        groupId = found ? found.id : (await repo.one(db, 'INSERT INTO garage_part_groups(business_id,name,created_by) VALUES($1,$2,$3) RETURNING id', [business.id, groupName, user.id])).id;
      }
    }
    await db.query(`INSERT INTO garage_parts(business_id,sku_id,superseded_by_sku_id,group_id,updated_by) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT (business_id,sku_id) DO UPDATE SET superseded_by_sku_id=EXCLUDED.superseded_by_sku_id,group_id=EXCLUDED.group_id,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [business.id, sku.id, newer, groupId, user.id]);
    await repo.audit(db, business.id, user.id, 'garage_part.links_changed', sku.id, { part: sku.label,
      from: { supersededBy: before?.superseded_by_sku_id ? Number(before.superseded_by_sku_id) : null, groupId: before?.group_id ? Number(before.group_id) : null },
      to: { supersededBy: newer ? Number(newer) : null, groupId: groupId ? Number(groupId) : null } });
    return partOf(db, business, sku.id);
  });
}

async function partOf(db, business, skuId) {
  return repo.one(db, `SELECT s.id AS sku_id,s.label,s.code,p.superseded_by_sku_id,n.label AS superseded_by_label,p.group_id,g.name AS group_name
    FROM catalog_skus s LEFT JOIN garage_parts p ON p.business_id=s.business_id AND p.sku_id=s.id
    LEFT JOIN catalog_skus n ON n.business_id=p.business_id AND n.id=p.superseded_by_sku_id
    LEFT JOIN garage_part_groups g ON g.business_id=p.business_id AND g.id=p.group_id WHERE s.business_id=$1 AND s.id=$2`, [business.id, skuId]);
}

async function groups(business) {
  c.requireGarage(business);
  await access.requireAny(business, READERS);
  return repo.all(repo.pool, `SELECT g.id,g.name,(SELECT count(*)::int FROM garage_parts p WHERE p.business_id=g.business_id AND p.group_id=g.id) AS parts
    FROM garage_part_groups g WHERE g.business_id=$1 ORDER BY lower(g.name)`, [business.id]);
}

// --- Stock and substitutes ---------------------------------------------------------------------------

// The location whose stock is shown: the one asked for, or the person's own (null: every location).
function locationOf(business, query) {
  if (c.given(query?.locationId)) {
    const locationId = id(query.locationId, 'Location');
    access.requireLocation(business, locationId);
    return locationId;
  }
  return business.location_scope || business.member_location_id || null;
}
// Usable stock of an item: at the location (or everywhere), not past its expiry.
const STOCK_SQL = (sku) => `COALESCE((SELECT sum(l.quantity) FROM business_stock_lots l WHERE l.business_id=$1 AND l.sku_id=${sku}
    AND ($2::bigint IS NULL OR l.location_id=$2) AND (l.expires_on IS NULL OR l.expires_on >= (now() AT TIME ZONE $3)::date)),0)`;

// A part's substitutes: its newer and older numbers and its group's other parts.
async function substitutesOf(db, business, skuId, locationId) {
  return repo.all(db, `WITH RECURSIVE newer(sku, depth) AS (
        SELECT p.superseded_by_sku_id, 1 FROM garage_parts p WHERE p.business_id=$1 AND p.sku_id=$4 AND p.superseded_by_sku_id IS NOT NULL
        UNION SELECT p.superseded_by_sku_id, n.depth + 1 FROM garage_parts p JOIN newer n ON p.business_id=$1 AND p.sku_id=n.sku
          WHERE p.superseded_by_sku_id IS NOT NULL AND n.depth < 20),
      older(sku, depth) AS (
        SELECT p.sku_id, 1 FROM garage_parts p WHERE p.business_id=$1 AND p.superseded_by_sku_id=$4
        UNION SELECT p.sku_id, o.depth + 1 FROM garage_parts p JOIN older o ON p.business_id=$1 AND p.superseded_by_sku_id=o.sku WHERE o.depth < 20),
      found AS (
        SELECT sku, 'newer' AS why, depth FROM newer
        UNION ALL SELECT sku, 'older', depth FROM older
        UNION ALL SELECT g.sku_id, 'group', 0 FROM garage_parts me JOIN garage_parts g ON g.business_id=me.business_id AND g.group_id=me.group_id AND g.sku_id<>me.sku_id
          WHERE me.business_id=$1 AND me.sku_id=$4 AND me.group_id IS NOT NULL)
    SELECT DISTINCT ON (s.id) s.id,s.label,s.code,s.unit,s.price,s.mrp,f.why,f.depth,${STOCK_SQL('s.id')} AS in_stock
    FROM found f JOIN catalog_skus s ON s.business_id=$1 AND s.id=f.sku JOIN catalog_products pr ON pr.business_id=s.business_id AND pr.id=s.product_id
    WHERE s.id<>$4 AND s.active AND pr.active ORDER BY s.id,CASE f.why WHEN 'newer' THEN 0 WHEN 'group' THEN 1 ELSE 2 END,f.depth`,
  [business.id, locationId, business.timezone || 'Asia/Kolkata', skuId]).then((rows) => rows
    .map((r) => ({ ...r, id: Number(r.id), in_stock: Number(r.in_stock) }))
    .sort((a, b) => (b.in_stock > 0) - (a.in_stock > 0) || ['newer', 'group', 'older'].indexOf(a.why) - ['newer', 'group', 'older'].indexOf(b.why) || a.label.localeCompare(b.label)));
}

// query: { locationId? }
async function substitutes(business, skuId, query = {}) {
  c.requireGarage(business);
  await access.requireAny(business, READERS);
  const locationId = locationOf(business, query);
  const sku = await goodsItem(repo.pool, business, skuId);
  const own = await repo.one(repo.pool, `SELECT ${STOCK_SQL('$4')} AS in_stock`, [business.id, locationId, business.timezone || 'Asia/Kolkata', sku.id]);
  return { part: { id: Number(sku.id), label: sku.label, code: sku.code, in_stock: Number(own.in_stock) }, locationId, substitutes: await substitutesOf(repo.pool, business, sku.id, locationId) };
}

// The parts that fit a vehicle, in stock first; each out of stock with its
// substitutes in stock. query: { q?, locationId? }
async function fits(business, vehicleId, query = {}) {
  c.requireGarage(business);
  await access.requireAny(business, READERS);
  const locationId = locationOf(business, query);
  const vehicle = await repo.one(repo.pool, `SELECT id,registration_no,make,model,variant,fuel,year,engine_code,concat_ws(' ',make,model,variant) AS vehicle_name
    FROM garage_vehicles WHERE business_id=$1 AND id=$2`, [business.id, id(vehicleId, 'Vehicle')]);
  if (!vehicle) fail('Vehicle not found', 404);
  const q = typeof query.q === 'string' && query.q.trim() ? `%${query.q.trim().slice(0, 60).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  const rows = await repo.all(repo.pool, `SELECT s.id,s.label,s.code,s.unit,s.price,s.mrp,${STOCK_SQL('s.id')} AS in_stock,
      bool_or(f.variant IS NOT NULL AND $7::text IS NULL OR f.fuel IS NOT NULL AND $8::text IS NULL OR (f.year_from IS NOT NULL OR f.year_to IS NOT NULL) AND $9::int IS NULL
        OR f.engine_code IS NOT NULL AND $10::text IS NULL) AS check_it,
      string_agg(DISTINCT concat_ws(' ',f.make,f.model,f.variant,f.engine_code), '; ') AS fits
    FROM garage_part_fitments f JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id JOIN catalog_products pr ON pr.business_id=s.business_id AND pr.id=s.product_id
    WHERE f.business_id=$1 AND s.active AND pr.active AND lower(f.make)=lower($5)
      AND (f.model IS NULL OR lower(f.model)=lower($6))
      AND (f.variant IS NULL OR $7::text IS NULL OR lower(f.variant)=lower($7))
      AND (f.fuel IS NULL OR $8::text IS NULL OR f.fuel=$8)
      AND ($9::int IS NULL OR ((f.year_from IS NULL OR $9 >= f.year_from) AND (f.year_to IS NULL OR $9 <= f.year_to)))
      AND (f.engine_code IS NULL OR $10::text IS NULL OR f.engine_code=$10)
      AND ($4::text IS NULL OR s.label ILIKE $4 OR s.code ILIKE $4)
    GROUP BY s.id ORDER BY (${STOCK_SQL('s.id')} > 0) DESC,s.label LIMIT ${MAX_FITS}`,
  [business.id, locationId, business.timezone || 'Asia/Kolkata', q, vehicle.make, vehicle.model, vehicle.variant, vehicle.fuel, vehicle.year, vehicle.engine_code]);
  const parts = [];
  for (const row of rows) {
    const inStock = Number(row.in_stock);
    // One query at a time on the pool is fine; an out-of-stock part brings its substitutes in stock.
    const offered = inStock > 0 ? [] : (await substitutesOf(repo.pool, business, row.id, locationId)).filter((x) => x.in_stock > 0);
    parts.push({ ...row, id: Number(row.id), in_stock: inStock, substitutes: offered });
  }
  return { vehicle, locationId, parts };
}

// --- Importing fitment from a CSV file --------------------------------------------------------------

const COLUMNS = [
  { key: 'part', label: 'Part code', need: 'always', aliases: ['partcode', 'part', 'code', 'itemcode', 'sku', 'partno', 'partnumber', 'barcode'],
    help: 'The part\'s item code (or barcode) as in your products.', example: 'BP-1021' },
  { key: 'make', label: 'Make', need: 'always', aliases: ['make', 'brand', 'manufacturer', 'vehiclemake'], help: 'The vehicle\'s make.', example: 'Maruti Suzuki' },
  { key: 'model', label: 'Model', need: 'optional', aliases: ['model', 'vehiclemodel'], help: 'Empty: every model of the make.', example: 'Swift' },
  { key: 'variant', label: 'Variant', need: 'optional', aliases: ['variant', 'trim'], help: 'Empty: every variant.', example: 'VXi' },
  { key: 'fuel', label: 'Fuel', need: 'optional', aliases: ['fuel', 'fueltype'], help: 'petrol, diesel, cng, petrol_cng, lpg, electric or hybrid; empty: any.', example: 'petrol' },
  { key: 'yearFrom', label: 'Year from', need: 'optional', aliases: ['yearfrom', 'from', 'fromyear', 'startyear'], help: 'The first model year it fits.', example: '2018' },
  { key: 'yearTo', label: 'Year to', need: 'optional', aliases: ['yearto', 'to', 'toyear', 'endyear'], help: 'The last model year it fits.', example: '2023' },
  { key: 'engineCode', label: 'Engine code', need: 'optional', aliases: ['enginecode', 'engine'], help: 'The engine\'s code; empty: any.', example: 'K12M' },
];
const importGuide = () => sheet.guideOf(COLUMNS, {
  columns: COLUMNS.map((x) => x.label),
  rows: [['BP-1021', 'Maruti Suzuki', 'Swift', '', 'petrol', '2018', '2023', 'K12M'], ['BP-1021', 'Maruti Suzuki', 'Dzire', '', '', '2018', '', '']],
});

async function planImport(db, business, rawRows) {
  const columns = sheet.resolveColumns(rawRows, COLUMNS);
  const problems = [], rows = [];
  for (const key of ['part', 'make']) if (!columns.byKey[key]) problems.push({ line: 1, column: key, message: `The file needs a ${COLUMNS.find((x) => x.key === key).label} column` });
  const skus = await repo.all(db, `SELECT s.id,s.label,s.code,s.barcode,p.kind FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    WHERE s.business_id=$1`, [business.id]);
  const byCode = new Map();
  for (const s of skus) {
    byCode.set(String(s.code).toUpperCase(), s);
    if (s.barcode) byCode.set(String(s.barcode).toUpperCase(), s);
  }
  const kept = await repo.all(db, 'SELECT sku_id,make,model,variant,fuel,year_from,year_to,engine_code FROM garage_part_fitments WHERE business_id=$1', [business.id]);
  const keyOf = (skuId, f) => [skuId, f.make, f.model, f.variant, f.fuel, f.yearFrom, f.yearTo, f.engineCode].map((x) => String(x ?? '').toLowerCase()).join('|');
  const have = new Set(kept.map((k) => keyOf(Number(k.sku_id), { make: k.make, model: k.model, variant: k.variant, fuel: k.fuel, yearFrom: k.year_from, yearTo: k.year_to, engineCode: k.engine_code })));
  const seen = new Map();
  rawRows.forEach((raw, index) => {
    const line = index + 2;
    const cells = sheet.cellsOf(raw, columns.byKey);
    const problem = (column, message) => problems.push({ line, column, message });
    const before = problems.length;
    const sku = cells.part ? byCode.get(String(cells.part).trim().toUpperCase()) : null;
    if (!cells.part) problem('part', 'Give the part\'s code');
    else if (!sku) problem('part', `No item has the code ${cells.part}`);
    else if (sku.kind !== 'goods') problem('part', `${sku.label} is a service: a part is an item kept in stock`);
    let fitment = null;
    try {
      fitment = readFitment({ make: cells.make, model: cells.model, variant: cells.variant, fuel: cells.fuel ? String(cells.fuel).toLowerCase().trim() : '', yearFrom: cells.yearFrom,
        yearTo: cells.yearTo, engineCode: cells.engineCode });
    } catch (error) { problem('make', error.message); }
    if (problems.length > before) return;
    const key = keyOf(Number(sku.id), fitment);
    if (seen.has(key)) { problem('part', `Row ${seen.get(key)} gives this fitment already`); return; }
    seen.set(key, line);
    const exists = have.has(key);
    rows.push({ line, key, name: `${sku.label}: ${fitmentWords(fitment)}`, action: exists ? 'unchanged' : 'create', changes: [], notes: [], state: null,
      write: exists ? null : { sku, fitment } });
  });
  return { columns, problems, rows };
}

// body: { rows, dryRun?, fileName?, fingerprint? } — what the import screen sends.
async function importFitments(business, user, body) {
  c.requireGarage(business);
  await access.require(business, 'catalog.edit');
  const rows = v.requiredArray(body.rows, 'Rows');
  sheet.checkRows(rows);
  const dryRun = v.requiredBoolean(body.dryRun, 'Dry run', false);
  const fingerprint = v.optionalString(body.fingerprint, 'Preview check', 100);
  const fileName = v.optionalString(body.fileName, 'File name', 200);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const planned = await planImport(db, business, rows);
    const summary = sheet.summarise(planned, planned.columns);
    if (!summary.ok || dryRun) return summary;
    if (fingerprint && fingerprint !== summary.fingerprint) throw sheet.staleError();
    for (const row of planned.rows) if (row.write) await insertFitment(db, business, user, row.write.sku, row.write.fitment);
    await repo.audit(db, business.id, user.id, 'garage_part.fitments_imported', business.id, { file: fileName || 'Spreadsheet import', created: summary.created, unchanged: summary.unchanged });
    return summary;
  });
}

module.exports = { listCheck, addFitment, removeFitment, setPart, groups, substitutes, fits, importGuide, importFitments };
