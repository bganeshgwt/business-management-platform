const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const sheet = require('../../../../utils/sheetImport');

// Paint tinting (module "hardware_tinting", a hardware shop's): tinted paint
// is made to order: a base item in its pack, tinted to a maker's shade on
// the maker's own machine (nothing here drives the machine), with a tinting
// charge billed as a service line at its own GST slab.
//
//   shades      per maker: the shade code, its name, its card, the base it
//               needs and an optional formula (colourant codes and millilitres
//               for one litre of base); typed, or imported from a spreadsheet
//               with the platform's import safety (a check first, all or
//               nothing, the same file twice changes nothing)
//   tinted line a bill's or a quotation's line of a base item with a shade
//               ({ tint: { shadeId } }); the base's details may say which base
//               it is (paintBase), and a shade needing another base is refused
//   jobs        each tinted line of a bill is a job on the tinting board:
//               queued -> tinted (the base leaves stock then, through the core:
//               business.service.js › deliverLine) -> handed over. Billing
//               keeps it free: the base in stock, less what waits on the
//               board, must cover it
//   take back   a tinted line is never taken back on an ordinary return (a
//               database trigger): only here, on a manager's PIN, as a return
//               that puts nothing back in stock (a tinted tin is no longer
//               base paint), with its activity log row
// Money and stock always go through the core.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const given = (value) => value !== undefined && value !== null && value !== '';
const normal = (text) => String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const milli = (value) => Math.round(Number(value) * 1000);
const qty = (m) => (m / 1000).toFixed(3);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
const MODULE_OFF = 'Paint tinting is not switched on for this business. An owner can turn it on in Settings › Business tools.';
// The most colourants one formula names.
const MOST_COLOURANTS = 12;
// The core and the services that need it, loaded when first used: the core loads this one.
const core = () => require('../../core/services/business.service');
const returns = () => require('../../core/services/businessReturns.service');
const pins = () => require('../../salon-weight/services/businessManagerPin');

function requireTinting(business) {
  if (business.business_type !== 'hardware') fail('Paint tinting belongs to hardware shops', 404);
  if (!business.modules.includes('hardware_tinting')) fail(MODULE_OFF, 403);
}

const JOB_SQL = `SELECT j.*,d.document_no,d.created_at AS billed_at,COALESCE(d.contact_name,'Walk-in') AS customer,
  dl.label,dl.unit,dl.entered_unit,dl.entered_quantity,dl.lot_code,sk.attributes->>'litresPerUnit' AS litres_per_unit,
  sh.maker,sh.code AS shade_code,sh.name AS shade_name,sh.card,sh.base,sh.formula,loc.name AS location_name,
  tu.name AS tinted_by_name,hu.name AS handed_over_by_name,au.name AS approved_by_name
  FROM hardware_tint_jobs j JOIN business_documents d ON d.business_id=j.business_id AND d.id=j.document_id
  JOIN business_document_lines dl ON dl.business_id=j.business_id AND dl.id=j.line_id
  JOIN catalog_skus sk ON sk.business_id=j.business_id AND sk.id=j.sku_id
  JOIN hardware_shades sh ON sh.business_id=j.business_id AND sh.id=j.shade_id
  JOIN business_locations loc ON loc.business_id=j.business_id AND loc.id=j.location_id
  LEFT JOIN users tu ON tu.id=j.tinted_by LEFT JOIN users hu ON hu.id=j.handed_over_by LEFT JOIN users au ON au.id=j.approved_by
  WHERE j.business_id=$1`;

repo.addLists({
  'hardware-shades': {
    sql: `SELECT s.*,(SELECT count(*)::int FROM hardware_tint_jobs j WHERE j.business_id=s.business_id AND j.shade_id=s.id) AS job_count
      FROM hardware_shades s WHERE s.business_id=$1`,
    search: ['maker', 'code', 'name', 'card', 'base'], filters: { active: 'active', maker: 'maker', base: 'base', id: 'id' }, order: 'active DESC,maker,code',
  },
  // The board: what waits to be tinted first, then what waits to be handed over.
  'hardware-tint-jobs': {
    sql: JOB_SQL, search: ['document_no', 'customer', 'shade_code', 'shade_name', 'label', 'maker'], date: 'created_at',
    filters: { status: 'status', location: 'location_id', document: 'document_id' },
    order: "CASE status WHEN 'queued' THEN 0 WHEN 'tinted' THEN 1 WHEN 'handed_over' THEN 2 ELSE 3 END,created_at,id",
  },
});

// --- Shades ---------------------------------------------------------------------------------------

// A formula: colourant codes and millilitres for one litre of base, as a list
// [{ colourant, ml }] or as typed in a spreadsheet: "XR 1.25; YE 0.4".
function readFormula(value) {
  if (!given(value)) return [];
  let entries = value;
  if (typeof value === 'string') {
    entries = value.split(/[;,]/).map((part) => part.trim()).filter(Boolean).map((part) => {
      const match = /^([A-Za-z0-9-]{1,10})\s*[:= ]\s*(\d+(?:\.\d+)?)\s*(?:ml)?$/i.exec(part);
      if (!match) fail(`"${part}" is not a colourant and its millilitres (write it like XR 1.25)`);
      return { colourant: match[1], ml: match[2] };
    });
  }
  const list = v.requiredArray(entries, 'Formula');
  if (list.length > MOST_COLOURANTS) fail(`A formula names at most ${MOST_COLOURANTS} colourants`);
  const formula = list.map((entry) => {
    const colourant = v.requiredString(entry?.colourant, 'Colourant', 10).toUpperCase();
    if (!/^[A-Z0-9-]{1,10}$/.test(colourant)) fail('A colourant is its code, like XR or YE');
    const ml = core().decimal(entry?.ml, `Millilitres of ${colourant}`, 3, 0.001, 1000);
    return { colourant, ml: String(ml) };
  });
  if (new Set(formula.map((f) => f.colourant)).size !== formula.length) fail('Each colourant is named once in a formula');
  return formula;
}
function readShade(body) {
  const space = (text) => text.replace(/\s+/g, ' ');
  return {
    maker: space(v.requiredString(body.maker, 'Paint maker', 80)), code: space(v.requiredString(body.code, 'Shade code', 30)),
    name: space(v.requiredString(body.name, 'Shade name', 100)), card: v.optionalString(body.card, 'Shade card', 100), base: space(v.requiredString(body.base, 'Base it needs', 40)),
    formula: readFormula(body.formula),
  };
}
async function codeFree(db, business, maker, code, exceptId = null) {
  const clash = await repo.one(db, 'SELECT name FROM hardware_shades WHERE business_id=$1 AND lower(maker)=lower($2) AND upper(code)=upper($3) AND ($4::bigint IS NULL OR id<>$4)',
    [business.id, maker, code, exceptId]);
  if (clash) fail(`${maker} shade ${code} is already kept (${clash.name})`, 409);
}

// body: { maker, code, name, card?, base, formula? }
async function createShade(business, user, body) {
  requireTinting(business);
  await access.require(business, 'hardware_tinting.edit');
  const f = readShade(body);
  return repo.transaction(async (db) => {
    await codeFree(db, business, f.maker, f.code);
    const row = await repo.one(db, `INSERT INTO hardware_shades(business_id,maker,code,name,card,base,formula,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
      [business.id, f.maker, f.code, f.name, f.card, f.base, JSON.stringify(f.formula), user.id]);
    await repo.audit(db, business.id, user.id, 'shade.created', row.id, { maker: row.maker, code: row.code, name: row.name, base: row.base });
    return row;
  });
}

// body: the same, and active? — a shade switched off is put on no new line; its jobs keep it.
async function updateShade(business, user, shadeId, body) {
  requireTinting(business);
  await access.require(business, 'hardware_tinting.edit');
  const f = readShade(body);
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM hardware_shades WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(shadeId, 'Shade')]);
    if (!current) fail('Shade not found', 404);
    const active = v.requiredBoolean(body.active, 'Active', current.active);
    await codeFree(db, business, f.maker, f.code, current.id);
    const row = await repo.one(db, `UPDATE hardware_shades SET maker=$3,code=$4,name=$5,card=$6,base=$7,formula=$8,active=$9,updated_by=$10,updated_at=now()
      WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, current.id, f.maker, f.code, f.name, f.card, f.base, JSON.stringify(f.formula), active, user.id]);
    await repo.audit(db, business.id, user.id, active === current.active ? 'shade.updated' : active ? 'shade.switched_on' : 'shade.switched_off', row.id,
      { maker: row.maker, code: row.code, name: row.name });
    return row;
  });
}

// --- Shades from a spreadsheet ------------------------------------------------------------------

const COLUMNS = [
  { key: 'maker', label: 'Maker', need: 'always', aliases: ['maker', 'paintmaker', 'brand', 'company', 'manufacturer'], help: 'The paint maker whose shade it is.', example: 'Example Paints' },
  { key: 'code', label: 'Shade code', need: 'always', aliases: ['shadecode', 'code', 'shade', 'shadeno', 'shadenumber'], help: 'The code on the shade card; a maker\'s code is kept once.', example: '7974' },
  { key: 'name', label: 'Shade name', need: 'new', aliases: ['shadename', 'name', 'colour', 'colourname', 'color', 'colorname'], help: 'The shade\'s name on the card.', example: 'Morning glow' },
  { key: 'card', label: 'Card', need: 'optional', aliases: ['card', 'shadecard', 'collection', 'fandeck', 'range'], help: 'The shade card or collection.', example: 'Interior colours 2026' },
  { key: 'base', label: 'Base', need: 'new', aliases: ['base', 'basepaint', 'basecode', 'basetype'], help: 'The base the shade is tinted from.', example: 'Pastel' },
  { key: 'formula', label: 'Formula (ml per litre)', need: 'optional', aliases: ['formula', 'formulamlperlitre', 'colourants', 'tinters', 'recipe'],
    help: 'Each colourant\'s code and its millilitres for one litre of base, separated by ;', example: 'XR 1.25; YE 0.4' },
  { key: 'active', label: 'In use', need: 'optional', aliases: ['inuse', 'active', 'status'], help: 'yes or no; a shade switched off is put on no new line.', example: 'yes' },
];
const LABELS = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label]));

const importGuide = () => sheet.guideOf(COLUMNS, {
  columns: COLUMNS.map((c) => c.label),
  rows: [['Example Paints', '1001', 'Example shade one', 'Example card', 'Pastel', 'XR 1.25; YE 0.4', 'yes'],
    ['Example Paints', '1002', 'Example shade two', 'Example card', 'Deep', 'BK 2.5; RO 0.75', 'yes']],
});

// Every row planned against the shades kept now: new, changed or unchanged.
async function plan(db, business, rawRows) {
  const columns = sheet.resolveColumns(rawRows, COLUMNS);
  const problems = [], rows = [];
  for (const key of ['maker', 'code']) if (!columns.byKey[key]) problems.push({ line: 1, column: key, message: `The file needs a ${LABELS[key]} column` });
  const kept = await repo.all(db, 'SELECT * FROM hardware_shades WHERE business_id=$1', [business.id]);
  const byKey = new Map(kept.map((s) => [`${normal(s.maker)}|${s.code.toUpperCase()}`, s]));
  const seen = new Map();
  rawRows.forEach((raw, index) => {
    const line = index + 2;
    const cells = sheet.cellsOf(raw, columns.byKey);
    const has = (key) => columns.byKey[key] && cells[key] !== '';
    const problem = (column, message) => problems.push({ line, column, message });
    const before = problems.length;
    if (!has('maker')) problem('maker', 'Give the paint maker');
    if (!has('code')) problem('code', 'Give the shade code');
    if (problems.length > before) return;
    const maker = cells.maker.replace(/\s+/g, ' ').slice(0, 80), code = cells.code.replace(/\s+/g, ' ').slice(0, 30);
    const key = `${normal(maker)}|${code.toUpperCase()}`;
    if (seen.has(key)) { problem('code', `Row ${seen.get(key)} gives this shade already`); return; }
    seen.set(key, line);
    const existing = byKey.get(key);
    const values = {};
    if (has('name')) values.name = cells.name.replace(/\s+/g, ' ').slice(0, 100);
    if (has('card')) values.card = cells.card.slice(0, 100);
    if (has('base')) values.base = cells.base.replace(/\s+/g, ' ').slice(0, 40);
    if (has('formula')) {
      try { values.formula = readFormula(cells.formula); } catch (error) { problem('formula', error.message); }
    }
    if (has('active')) {
      const yes = sheet.parseYesNo(cells.active);
      if (yes.error) problem('active', yes.error); else values.active = yes.value;
    }
    if (!existing && !values.name) problem('name', 'A new shade needs its name');
    if (!existing && !values.base) problem('base', 'A new shade needs the base it is tinted from');
    if (problems.length > before) return;
    const changes = [];
    if (existing) {
      for (const [field, value] of Object.entries(values)) {
        // A formula is compared as its words: the database keeps an object's keys in its own order.
        const was = field === 'formula' ? formulaWords(existing.formula) : existing[field];
        const now = field === 'formula' ? formulaWords(value) : value;
        if (String(was ?? '') !== String(now ?? '')) {
          changes.push({ field, label: LABELS[field], from: field === 'formula' ? formulaWords(existing.formula) : was ?? '—', to: field === 'formula' ? formulaWords(value) : value });
        }
      }
    }
    rows.push({
      line, key, name: `${maker} ${code} ${values.name || existing?.name || ''}`.trim(), action: !existing ? 'create' : changes.length ? 'update' : 'unchanged', changes, notes: [],
      details: existing ? undefined : { base: values.base, formula: values.formula?.length ? formulaWords(values.formula) : null },
      state: existing ? [existing.name, existing.card, existing.base, formulaWords(existing.formula), existing.active] : null,
      write: { existingId: existing?.id || null, maker, code, values },
    });
  });
  return { columns, problems, rows };
}
const formulaWords = (formula) => (formula || []).map((f) => `${f.colourant} ${f.ml}`).join('; ');

// body: { rows, dryRun?, fileName?, fingerprint? } — what the import screen sends.
async function importShades(business, user, body) {
  requireTinting(business);
  await access.require(business, 'hardware_tinting.edit');
  const rows = v.requiredArray(body.rows, 'Rows');
  sheet.checkRows(rows);
  const dryRun = v.requiredBoolean(body.dryRun, 'Dry run', false);
  const fingerprint = v.optionalString(body.fingerprint, 'Preview check', 100);
  const fileName = v.optionalString(body.fileName, 'File name', 200);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const planned = await plan(db, business, rows);
    const summary = sheet.summarise(planned, planned.columns);
    if (!summary.ok || dryRun) return summary;
    if (fingerprint && fingerprint !== summary.fingerprint) throw sheet.staleError();
    for (const row of planned.rows) {
      if (row.action === 'unchanged') continue;
      const { existingId, maker, code, values } = row.write;
      if (!existingId) {
        await db.query(`INSERT INTO hardware_shades(business_id,maker,code,name,card,base,formula,active,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
          [business.id, maker, code, values.name, values.card || null, values.base, JSON.stringify(values.formula || []), values.active ?? true, user.id]);
      } else {
        const set = Object.keys(values);
        await db.query(`UPDATE hardware_shades SET ${set.map((key, at) => `${key}=$${at + 3}`).join(',')},updated_by=$${set.length + 3},updated_at=now() WHERE business_id=$1 AND id=$2`,
          [business.id, existingId, ...set.map((key) => (key === 'formula' ? JSON.stringify(values[key]) : values[key])), user.id]);
      }
    }
    await repo.audit(db, business.id, user.id, 'shade.imported', business.id, { file: fileName || 'Spreadsheet import', created: summary.created, updated: summary.updated, unchanged: summary.unchanged });
    return summary;
  });
}

// --- The tinting charge ---------------------------------------------------------------------------

async function settings(business) {
  requireTinting(business);
  await access.require(business, 'hardware_tinting.view');
  const row = await repo.one(repo.pool, `SELECT t.charge_sku_id,s.label,s.code,s.barcode,s.price,s.tax_rate,s.unit,s.active FROM hardware_tint_settings t
    LEFT JOIN catalog_skus s ON s.business_id=t.business_id AND s.id=t.charge_sku_id WHERE t.business_id=$1`, [business.id]);
  return { chargeSkuId: row?.charge_sku_id || null, charge: row?.charge_sku_id ? { id: row.charge_sku_id, label: row.label, code: row.code, barcode: row.barcode, price: row.price,
    taxRate: row.tax_rate, unit: row.unit, active: row.active } : null };
}

// body: { chargeSkuId } (null: no charge goes on by itself) — a service item, priced for one tin at its own GST slab.
async function saveSettings(business, user, body) {
  requireTinting(business);
  await access.require(business, 'hardware_tinting.edit');
  const chargeSkuId = given(body.chargeSkuId) ? id(body.chargeSkuId, 'Tinting charge') : null;
  await repo.transaction(async (db) => {
    if (chargeSkuId) {
      const sku = await repo.one(db, `SELECT s.id,s.label,s.active,p.kind FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
        WHERE s.business_id=$1 AND s.id=$2`, [business.id, chargeSkuId]);
      if (!sku) fail('Item not found', 404);
      if (sku.kind !== 'service' || !sku.active) fail(`${sku.label} is not a service item that is on: the tinting charge is billed as a service`);
    }
    const was = await repo.one(db, 'SELECT charge_sku_id FROM hardware_tint_settings WHERE business_id=$1', [business.id]);
    await db.query(`INSERT INTO hardware_tint_settings(business_id,charge_sku_id,updated_by) VALUES($1,$2,$3)
      ON CONFLICT (business_id) DO UPDATE SET charge_sku_id=EXCLUDED.charge_sku_id,updated_by=EXCLUDED.updated_by,updated_at=now()`, [business.id, chargeSkuId, user.id]);
    if (String(was?.charge_sku_id ?? '') !== String(chargeSkuId ?? '')) {
      await repo.audit(db, business.id, user.id, 'tinting.settings_changed', business.id, { chargeSkuId: { from: was?.charge_sku_id || null, to: chargeSkuId } });
    }
  });
  return settings(business);
}

// --- Tinted lines on a bill (inside the sale's own posting) --------------------------------------

// The lines a body asks to tint: input line index -> shade id. null: none.
function readTints(business, inputLines) {
  const asked = (Array.isArray(inputLines) ? inputLines : []).map((line, index) => [index, line?.tint]).filter(([, tint]) => given(tint));
  if (!asked.length) return null;
  if (business.business_type !== 'hardware') fail('Tinted paint belongs to a hardware shop\'s bills and quotations');
  if (!business.modules.includes('hardware_tinting')) fail(MODULE_OFF, 403);
  const map = new Map();
  for (const [index, tint] of asked) {
    if (typeof tint !== 'object' || Array.isArray(tint)) fail('A tinted line names its shade: { shadeId }');
    map.set(index, id(tint.shadeId, 'Shade'));
  }
  return map;
}

// The shade for a base item: on, and needing the base the item is (when its details say).
async function shadeFor(db, business, sku, shadeId) {
  if (sku.kind !== 'goods' || sku.tracking === 'none' || sku.tracking === 'serial') fail(`${sku.label} is not paint kept in stock by quantity or batch: only such a base is tinted`);
  const shade = await repo.one(db, 'SELECT * FROM hardware_shades WHERE business_id=$1 AND id=$2', [business.id, shadeId]);
  if (!shade) fail('Shade not found', 404);
  if (!shade.active) fail(`Shade ${shade.code} ${shade.name} is switched off: switch it on again to tint it`, 409);
  const base = sku.attributes?.paintBase;
  if (base && normal(base) !== normal(shade.base)) fail(`${shade.maker} shade ${shade.code} ${shade.name} needs the ${shade.base} base, and ${sku.label} is the ${base} base`, 409);
  return shade;
}

// A sale's tinted lines, checked after it is priced and before it is saved:
// a base kept in stock, a shade that is on and needs that base, and the base
// free at the location (in stock, less what waits on the tinting board) to
// cover it. Returns prepared line -> shade, or null; the core leaves these
// lines' base in stock until each job is tinted.
async function checkTints(db, business, { inputLines, prepared, location }) {
  const asked = readTints(business, inputLines);
  if (!asked) return null;
  await access.require(business, 'hardware_tinting.create');
  const tinted = new Map();
  for (const line of prepared) {
    if (!asked.has(line.inputIndex)) continue;
    if (line.kit) fail(`${line.sku.label} is part of a kit: a kit is not tinted`);
    tinted.set(line, await shadeFor(db, business, line.sku, asked.get(line.inputIndex)));
  }
  const wanted = new Map();
  for (const line of tinted.keys()) {
    const key = `${line.sku.id}|${line.lotCode}`;
    wanted.set(key, { line, need: (wanted.get(key)?.need || 0) + milli(line.quantity) });
  }
  for (const { line, need } of wanted.values()) {
    const free = await repo.one(db, `SELECT
      COALESCE((SELECT sum(quantity) FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=$3 AND lot_code=$4
        AND (expires_on IS NULL OR expires_on>=(now() AT TIME ZONE $5)::date)),0) AS stock,
      COALESCE((SELECT sum(j.quantity) FROM hardware_tint_jobs j JOIN business_document_lines dl ON dl.business_id=j.business_id AND dl.id=j.line_id
        WHERE j.business_id=$1 AND j.location_id=$2 AND j.sku_id=$3 AND dl.lot_code=$4 AND j.status='queued'),0) AS waiting`,
    [business.id, location.id, line.sku.id, line.lotCode, business.timezone]);
    const left = milli(free.stock) - milli(free.waiting);
    if (left < need) {
      const unit = line.sku.unit === 'each' ? '' : ` ${line.sku.unit}`;
      fail(`${line.sku.label}${line.lotCode ? ` (batch ${line.lotCode})` : ''}: only ${Math.max(0, left) / 1000}${unit} free to tint here`
        + `${milli(free.waiting) ? `, with ${milli(free.waiting) / 1000}${unit} waiting on the tinting board` : ''}`, 409);
    }
  }
  return tinted;
}

// After the bill and its lines are saved: one job for each tinted line.
async function recordTints(db, business, user, saved, tinted) {
  const jobs = [];
  for (const [line, shade] of tinted) {
    const row = await repo.one(db, `INSERT INTO hardware_tint_jobs(business_id,location_id,document_id,line_id,sku_id,shade_id,quantity,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [business.id, saved.location_id, saved.id, line.id, line.sku.id, shade.id, qty(milli(line.quantity)), user.id]);
    jobs.push({ jobId: row.id, lineId: line.id, label: line.sku.label, shade: `${shade.maker} ${shade.code} ${shade.name}`, quantity: qty(milli(line.quantity)) });
  }
  await repo.audit(db, business.id, user.id, 'tinting.queued', saved.id, { documentNo: saved.document_no, jobs });
  await repo.event(db, business.id, user.id, 'tinting.queued', 'document', saved.id, { documentNo: saved.document_no, locationId: saved.location_id, jobs });
}

// A bill's tinted lines, for its detail and print.
async function ofDocument(db, business, documentId) {
  return repo.all(db, `SELECT j.id,j.line_id,j.status,j.quantity,sh.maker,sh.code,sh.name,sh.card,sh.base FROM hardware_tint_jobs j
    JOIN hardware_shades sh ON sh.business_id=j.business_id AND sh.id=j.shade_id WHERE j.business_id=$1 AND j.document_id=$2 ORDER BY j.line_id`, [business.id, documentId]);
}

// --- Tinted lines on a quotation (inside its own posting) -----------------------------------------

// After an open quotation's lines are saved (in the order sent): their shades.
async function saveQuotationTints(db, business, quotation, inputLines) {
  const asked = readTints(business, inputLines);
  if (!asked) return;
  await access.require(business, 'hardware_tinting.create');
  const lines = await repo.all(db, `SELECT x.id,s.label,s.attributes,s.tracking,p.kind FROM business_quotation_lines x
    JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.sku_id JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    WHERE x.business_id=$1 AND x.quotation_id=$2 ORDER BY x.id`, [business.id, quotation.id]);
  for (const [index, shadeId] of asked) {
    const line = lines[index];
    if (!line) fail('A tinted line is not on this quotation');
    const shade = await shadeFor(db, business, line, shadeId);
    await db.query('INSERT INTO hardware_quotation_tints(business_id,line_id,quotation_id,shade_id) VALUES($1,$2,$3,$4)', [business.id, line.id, quotation.id, shade.id]);
  }
}
async function quotationTints(db, business, quotationId) {
  return repo.all(db, `SELECT t.line_id,t.shade_id,sh.maker,sh.code,sh.name,sh.card,sh.base,sh.active FROM hardware_quotation_tints t
    JOIN hardware_shades sh ON sh.business_id=t.business_id AND sh.id=t.shade_id WHERE t.business_id=$1 AND t.quotation_id=$2 ORDER BY t.line_id`, [business.id, quotationId]);
}

// --- The tinting board --------------------------------------------------------------------------

async function loadJob(db, business, jobId, { lock = false } = {}) {
  const job = await repo.one(db, `SELECT * FROM hardware_tint_jobs WHERE business_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [business.id, id(jobId, 'Tinting job')]);
  if (!job) fail('Tinting job not found', 404);
  access.requireLocation(business, job.location_id);
  return job;
}
const jobRow = (db, business, jobId) => repo.one(db, `${JOB_SQL} AND j.id=$2`, [business.id, jobId]);
const words = (job) => `job ${job.id} on ${job.document_no}`;

// Tinted: the base leaves stock now, through the core. Asking again is the same.
async function tinted(business, user, jobId) {
  requireTinting(business);
  await access.require(business, 'hardware_tinting.create');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const job = await loadJob(db, business, jobId, { lock: true });
    if (job.status === 'tinted' || job.status === 'handed_over') return jobRow(db, business, job.id);
    if (job.status !== 'queued') fail('This tinted line was taken back: there is nothing to tint', 409);
    const quantity = await core().deliverLine(db, business, job.document_id, job.line_id);
    await db.query("UPDATE hardware_tint_jobs SET status='tinted',tinted_by=$3,tinted_at=now() WHERE business_id=$1 AND id=$2", [business.id, job.id, user.id]);
    const row = await jobRow(db, business, job.id);
    await repo.audit(db, business.id, user.id, 'tinting.tinted', job.id, { documentNo: row.document_no, shade: `${row.maker} ${row.shade_code} ${row.shade_name}`, label: row.label, quantity });
    await repo.event(db, business.id, user.id, 'tinting.tinted', 'tint_job', job.id, { documentId: job.document_id, lineId: job.line_id, skuId: job.sku_id,
      locationId: job.location_id, quantity: qty(milli(quantity)) });
    return row;
  });
}

// Handed over to the customer. Asking again is the same.
async function handedOver(business, user, jobId) {
  requireTinting(business);
  await access.require(business, 'hardware_tinting.create');
  return repo.transaction(async (db) => {
    const job = await loadJob(db, business, jobId, { lock: true });
    if (job.status === 'handed_over') return jobRow(db, business, job.id);
    if (job.status !== 'tinted') fail(job.status === 'queued' ? 'Tint it first: a job is handed over once it is tinted' : 'This tinted line was taken back', 409);
    await db.query("UPDATE hardware_tint_jobs SET status='handed_over',handed_over_by=$3,handed_over_at=now() WHERE business_id=$1 AND id=$2", [business.id, job.id, user.id]);
    const row = await jobRow(db, business, job.id);
    await repo.audit(db, business.id, user.id, 'tinting.handed_over', job.id, { documentNo: row.document_no, shade: `${row.maker} ${row.shade_code} ${row.shade_name}` });
    await repo.event(db, business.id, user.id, 'tinting.handed_over', 'tint_job', job.id, { documentId: job.document_id, lineId: job.line_id, locationId: job.location_id });
    return row;
  });
}

// body: { requestKey, reason, approval: { approverId?, pin } } — a tinted line
// taken back on a manager's PIN (one who may take goods back), as a return
// of the whole line that puts nothing back in stock. Its money goes back as
// for any return, by a refund on the bill.
async function takeBack(business, user, jobId, body) {
  requireTinting(business);
  await access.require(business, 'hardware_tinting.create');
  const requestKey = core().uuid(body.requestKey);
  // The PIN is checked before the transaction: a PIN check holds no locks.
  const approval = await pins().readApproval(business, user, { ...(body.approval && typeof body.approval === 'object' ? body.approval : {}), reason: body.reason },
    'sales.refund', { reasonLabel: 'Why it is taken back' });
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const job = await loadJob(db, business, jobId, { lock: true });
    if (job.status === 'taken_back') {
      if (job.take_back_key === requestKey) return jobRow(db, business, job.id);
      fail(`This tinted line was already taken back (${words(await jobRow(db, business, job.id))})`, 409);
    }
    const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, job.document_id]);
    const back = await repo.one(db, 'SELECT COALESCE(sum(quantity),0) AS q FROM business_return_lines WHERE business_id=$1 AND line_id=$2', [business.id, job.line_id]);
    const left = milli(job.quantity) - milli(back.q);
    if (left <= 0) fail('Everything on this line has come back already', 409);
    await db.query(`UPDATE hardware_tint_jobs SET status='taken_back',take_back_key=$3,approved_by=$4,take_back_reason=$5,taken_back_by=$6,taken_back_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, job.id, requestKey, approval.approver.id, approval.reason, user.id]);
    const reason = `Tinted paint taken back: ${approval.reason}`.slice(0, 300);
    const saved = await returns().postReturn(db, business, user, doc, { reason, requestKey, hash: hashOf({ jobId: job.id, reason, requestKey }),
      lines: [{ lineId: job.line_id, quantity: qty(left), restock: false }] });
    const row = await jobRow(db, business, job.id);
    await repo.audit(db, business.id, user.id, 'tinting.taken_back', job.id, { documentNo: doc.document_no, returnNo: saved.return_no, total: saved.total,
      shade: `${row.maker} ${row.shade_code} ${row.shade_name}`, wasTinted: Boolean(job.tinted_at), approvedBy: approval.approver.name, reason: approval.reason });
    await repo.event(db, business.id, user.id, 'tinting.taken_back', 'tint_job', job.id, { documentId: doc.id, returnId: saved.id, approvedBy: approval.approver.id, locationId: job.location_id });
    return { ...row, return: { id: saved.id, return_no: saved.return_no, total: saved.total } };
  });
}

module.exports = { requireTinting, createShade, updateShade, importGuide, importShades, settings, saveSettings, readTints, checkTints, recordTints, ofDocument,
  saveQuotationTints, quotationTints, tinted, handedOver, takeBack, readFormula };
