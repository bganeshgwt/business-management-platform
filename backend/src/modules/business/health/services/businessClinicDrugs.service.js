const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const sheet = require('../../../../utils/sheetImport');
const h = require('./healthCommon');
const rules = require('./clinicDrugRules');

// The clinic's own drug list (health_clinic_drugs), kept by its doctors: each
// medicine's generic name, brand names, strength, form, route, the usual dose
// and how often, the most a day (amount and unit) and its allergy group;
// typed, or imported from a spreadsheet with the platform's import safety (a
// check first, all or nothing). A pharmacy's drug master stays its own.
//
// The consultation's prescription picks from it (a line written by hand is
// still allowed, marked as not on the list) and each line is checked as it
// is saved (clinicDrugRules): a known allergy of the patient, the same
// medicine or allergy group twice, a day's dose over the most. The doctor
// may go on, giving a reason for each warning; the warnings and reasons are
// kept with the line, clinical data like the rest of the consultation.

const { fail, id, text } = h;
const requireClinic = (business) => {
  h.requireType(business, ['healthcare'], 'Patient records');
  if (!business.modules.includes('patients')) fail('Patient records are not switched on for this business. An owner can turn them on in Settings › Business tools.', 403);
};

repo.addLists({
  'health-clinic-drugs': {
    sql: `SELECT d.*,(SELECT count(*)::int FROM health_prescription_items i WHERE i.business_id=d.business_id AND i.drug_id=d.id) AS prescribed
      FROM health_clinic_drugs d WHERE d.business_id=$1`,
    search: ['generic_name', 'brand_names', 'strength', 'form', 'allergy_group'], filters: { active: 'active', form: 'form', group: 'allergy_group' },
    order: 'active DESC,lower(generic_name),lower(COALESCE(strength,\'\')),id',
  },
});

const squash = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value);
const labelOf = (drug) => [drug.generic_name, drug.strength, drug.form].filter(Boolean).join(' ');

// The units of the most a day, as people write them.
const MAX_WORDS = { mg: 'mg', g: 'g', gm: 'g', gram: 'g', grams: 'g', mcg: 'mcg', ug: 'mcg', 'µg': 'mcg', microgram: 'mcg', micrograms: 'mcg', ml: 'ml',
  iu: 'IU', unit: 'units', units: 'units', u: 'units', tab: 'tablets', tabs: 'tablets', tablet: 'tablets', tablets: 'tablets', cap: 'capsules', caps: 'capsules',
  capsule: 'capsules', capsules: 'capsules', puff: 'puffs', puffs: 'puffs', drop: 'drops', drops: 'drops', sachet: 'sachets', sachets: 'sachets' };
const maxUnitOf = (word) => MAX_WORDS[String(word || '').trim().toLowerCase().replace(/\.$/, '')] || null;

// The most a day: { amount, unit } (both given) or null (neither).
function readMax(amountValue, unitValue) {
  const none = (value) => value === undefined || value === null || String(value).trim() === '';
  if (none(amountValue) && none(unitValue)) return null;
  if (none(amountValue) || none(unitValue)) fail('Give the most a day as an amount and its unit, or neither');
  const amount = Number(String(amountValue).replace(/,/g, '').trim());
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000 || Math.round(amount * 1000) !== amount * 1000) fail('The most a day is a number above 0, up to 3 decimals');
  const unit = maxUnitOf(unitValue);
  if (!unit) fail(`The most a day is in ${rules.MAX_UNITS.join(', ')}`);
  return { amount, unit };
}

// body: { genericName, brandNames, strength, form, route, usualDose,
// usualFrequency, maxDailyAmount, maxDailyUnit, allergyGroup, active }
function readDrug(body, current = null) {
  const keep = (key, column, name, max) => (body[key] === undefined ? (current ? current[column] : null) : text(squash(body[key]), name, max) || null);
  const generic = body.genericName === undefined && current ? current.generic_name : v.requiredString(squash(body.genericName), 'Generic name', 150);
  const maxGiven = body.maxDailyAmount !== undefined || body.maxDailyUnit !== undefined;
  const max = maxGiven ? readMax(body.maxDailyAmount, body.maxDailyUnit)
    : current?.max_daily_amount ? { amount: Number(current.max_daily_amount), unit: current.max_daily_unit } : null;
  return {
    generic_name: generic, brand_names: keep('brandNames', 'brand_names', 'Brand names', 300), strength: keep('strength', 'strength', 'Strength', 60),
    form: keep('form', 'form', 'Form', 40), route: keep('route', 'route', 'Route', 40), usual_dose: keep('usualDose', 'usual_dose', 'Usual dose', 60),
    usual_frequency: keep('usualFrequency', 'usual_frequency', 'How often', 60), max_daily_amount: max ? max.amount : null, max_daily_unit: max ? max.unit : null,
    allergy_group: keep('allergyGroup', 'allergy_group', 'Allergy group', 80), active: v.requiredBoolean(body.active, 'Active', current ? current.active : true),
  };
}

// One entry per generic, strength and form.
async function entryFree(db, business, f, except = null) {
  const taken = await repo.one(db, `SELECT id FROM health_clinic_drugs WHERE business_id=$1 AND lower(generic_name)=lower($2) AND lower(COALESCE(strength,''))=lower(COALESCE($3,''))
    AND lower(COALESCE(form,''))=lower(COALESCE($4,'')) AND ($5::bigint IS NULL OR id<>$5)`, [business.id, f.generic_name, f.strength, f.form, except]);
  if (taken) fail(`${labelOf(f)} is on the drug list already`, 409);
}

const COLUMNS_SQL = ['generic_name', 'brand_names', 'strength', 'form', 'route', 'usual_dose', 'usual_frequency', 'max_daily_amount', 'max_daily_unit', 'allergy_group', 'active'];

async function create(business, user, body) {
  requireClinic(business);
  await access.require(business, 'patients.edit_clinical');
  const f = readDrug(body);
  return repo.transaction(async (db) => {
    await entryFree(db, business, f);
    const row = await repo.one(db, `INSERT INTO health_clinic_drugs(business_id,${COLUMNS_SQL.join(',')},created_by,updated_by)
      VALUES($1,${COLUMNS_SQL.map((_, i) => `$${i + 2}`).join(',')},$${COLUMNS_SQL.length + 2},$${COLUMNS_SQL.length + 2}) RETURNING *`,
    [business.id, ...COLUMNS_SQL.map((c) => f[c]), user.id]);
    await repo.audit(db, business.id, user.id, 'clinic_drug.created', row.id, { drug: labelOf(row), group: row.allergy_group });
    return row;
  });
}

// The same body; a medicine switched off is offered on no new prescription
// (the prescriptions that named it keep it).
async function update(business, user, drugId, body) {
  requireClinic(business);
  await access.require(business, 'patients.edit_clinical');
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM health_clinic_drugs WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(drugId, 'Medicine')]);
    if (!current) fail('Medicine not found on the drug list', 404);
    const f = readDrug(body, current);
    await entryFree(db, business, f, current.id);
    const row = await repo.one(db, `UPDATE health_clinic_drugs SET ${COLUMNS_SQL.map((c, i) => `${c}=$${i + 3}`).join(',')},updated_by=$${COLUMNS_SQL.length + 3},updated_at=now()
      WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, current.id, ...COLUMNS_SQL.map((c) => f[c]), user.id]);
    const changed = COLUMNS_SQL.filter((c) => String(current[c] ?? '') !== String(row[c] ?? ''));
    await repo.audit(db, business.id, user.id, row.active === current.active ? 'clinic_drug.updated' : row.active ? 'clinic_drug.switched_on' : 'clinic_drug.switched_off',
      row.id, { drug: labelOf(row), changed });
    return row;
  });
}

// Every medicine on the list that is switched on, for the prescription.
async function picker(business) {
  requireClinic(business);
  await access.require(business, 'patients.edit_clinical');
  return repo.all(repo.pool, `SELECT id,generic_name,brand_names,strength,form,route,usual_dose,usual_frequency,max_daily_amount,max_daily_unit,allergy_group
    FROM health_clinic_drugs WHERE business_id=$1 AND active ORDER BY lower(generic_name),lower(COALESCE(strength,'')),lower(COALESCE(form,'')),id LIMIT 2000`, [business.id]);
}

// --- The list from a spreadsheet ---------------------------------------------------------

const COLUMNS = [
  { key: 'generic', label: 'Generic name', need: 'always', aliases: ['genericname', 'generic', 'drug', 'drugname', 'medicine', 'molecule', 'salt'], help: 'The medicine by its generic name.', example: 'Paracetamol' },
  { key: 'brands', label: 'Brand names', need: 'optional', aliases: ['brandnames', 'brands', 'brand', 'brandname', 'tradenames'], help: 'Brands it is sold as, separated by commas.', example: 'Dolo, Calpol' },
  { key: 'strength', label: 'Strength', need: 'optional', aliases: ['strength', 'potency'], help: 'As on the pack; with the form, it tells one entry from another.', example: '650 mg' },
  { key: 'form', label: 'Form', need: 'optional', aliases: ['form', 'dosageform'], help: 'Tablet, capsule, syrup, drops, injection…', example: 'Tablet' },
  { key: 'route', label: 'Route', need: 'optional', aliases: ['route', 'routeofadministration'], help: 'Oral, topical, IV, IM…', example: 'Oral' },
  { key: 'dose', label: 'Usual dose', need: 'optional', aliases: ['usualdose', 'dose', 'defaultdose'], help: 'Filled in when it is picked for a prescription.', example: '1 tab' },
  { key: 'frequency', label: 'How often', need: 'optional', aliases: ['howoften', 'frequency', 'usualfrequency', 'timing'], help: 'As the prescription writes it: 1-0-1, OD, BD, TDS, every 6 hours.', example: '1-1-1' },
  { key: 'max', label: 'Most a day', need: 'optional', aliases: ['mostaday', 'maxdaily', 'maxdailydose', 'maximumdailydose', 'maxperday', 'maximumdose', 'maxdose'],
    help: `The most in a day, an amount and its unit (${rules.MAX_UNITS.join(', ')}).`, example: '4000 mg' },
  { key: 'group', label: 'Allergy group', need: 'optional', aliases: ['allergygroup', 'group', 'drugclass', 'class'], help: 'Penicillins, sulfonamides, NSAIDs…: an allergy to one warns for all.', example: 'NSAIDs' },
  { key: 'active', label: 'In use', need: 'optional', aliases: ['inuse', 'active', 'status'], help: 'yes or no; a medicine switched off is offered on no new prescription.', example: 'yes' },
];
const LABELS = { generic_name: 'Generic name', brand_names: 'Brand names', strength: 'Strength', form: 'Form', route: 'Route', usual_dose: 'Usual dose',
  usual_frequency: 'How often', max_daily: 'Most a day', allergy_group: 'Allergy group', active: 'In use' };

const importGuide = () => sheet.guideOf(COLUMNS, {
  columns: COLUMNS.map((c) => c.label),
  rows: [['Paracetamol', 'Dolo, Calpol', '650 mg', 'Tablet', 'Oral', '1 tab', '1-1-1', '4000 mg', '', 'yes'],
    ['Amoxicillin', 'Mox, Novamox', '500 mg', 'Capsule', 'Oral', '1 cap', '1-1-1', '3000 mg', 'Penicillins', 'yes']],
});

const keyOf = (generic, strength, form) => [generic, strength || '', form || ''].map((part) => String(part).toLowerCase()).join('|');
const maxWords = (amount, unit) => (amount === null || amount === undefined ? '' : `${Number(amount)} ${unit}`);

// Every row planned against the list as it is: new, changed or unchanged.
async function plan(db, business, rawRows) {
  const columns = sheet.resolveColumns(rawRows, COLUMNS);
  const problems = [], rows = [];
  if (!columns.byKey.generic) problems.push({ line: 1, column: 'generic', message: 'The file needs a Generic name column' });
  const kept = await repo.all(db, 'SELECT * FROM health_clinic_drugs WHERE business_id=$1', [business.id]);
  const byKey = new Map(kept.map((d) => [keyOf(d.generic_name, d.strength, d.form), d]));
  const seen = new Map();
  rawRows.forEach((raw, index) => {
    const line = index + 2;
    const cells = sheet.cellsOf(raw, columns.byKey);
    const has = (key) => columns.byKey[key] && cells[key] !== '';
    const problem = (column, message) => problems.push({ line, column, message });
    const before = problems.length;
    if (!has('generic')) { problem('generic', 'Give the generic name'); return; }
    const generic = squash(cells.generic).slice(0, 150);
    const strength = has('strength') ? squash(cells.strength).slice(0, 60) : null;
    const form = has('form') ? squash(cells.form).slice(0, 40) : null;
    const key = keyOf(generic, strength, form);
    if (seen.has(key)) { problem('generic', `Row ${seen.get(key)} gives this medicine already`); return; }
    seen.set(key, line);
    const existing = byKey.get(key);
    const values = {};
    if (has('brands')) values.brand_names = squash(cells.brands).slice(0, 300);
    if (has('route')) values.route = squash(cells.route).slice(0, 40);
    if (has('dose')) values.usual_dose = squash(cells.dose).slice(0, 60);
    if (has('frequency')) values.usual_frequency = squash(cells.frequency).slice(0, 60);
    if (has('group')) values.allergy_group = squash(cells.group).slice(0, 80);
    if (has('max')) {
      const m = /^([\d.,]+)\s*([a-zA-Zµ.]+)$/.exec(squash(cells.max));
      try {
        if (!m) fail(`"${cells.max}" is not an amount and its unit (like 4000 mg)`);
        const max = readMax(m[1], m[2]);
        values.max_daily_amount = max.amount; values.max_daily_unit = max.unit;
      } catch (error) { problem('max', error.message); }
    }
    if (has('active')) {
      const yes = sheet.parseYesNo(cells.active);
      if (yes.error) problem('active', yes.error); else values.active = yes.value;
    }
    if (problems.length > before) return;
    const changes = [];
    if (existing) {
      for (const [field, value] of Object.entries(values)) {
        if (field === 'max_daily_unit') continue;
        const was = field === 'max_daily_amount' ? maxWords(existing.max_daily_amount, existing.max_daily_unit) : existing[field];
        const now = field === 'max_daily_amount' ? maxWords(value, values.max_daily_unit) : value;
        if (String(was ?? '') !== String(now ?? '')) changes.push({ field, label: LABELS[field === 'max_daily_amount' ? 'max_daily' : field], from: was ?? '—', to: now });
      }
    }
    rows.push({
      line, key, name: [generic, strength, form].filter(Boolean).join(' '), action: !existing ? 'create' : changes.length ? 'update' : 'unchanged', changes, notes: [],
      details: existing ? undefined : { group: values.allergy_group || null, max: maxWords(values.max_daily_amount, values.max_daily_unit) || null },
      state: existing ? [existing.brand_names, existing.route, existing.usual_dose, existing.usual_frequency, maxWords(existing.max_daily_amount, existing.max_daily_unit),
        existing.allergy_group, existing.active] : null,
      write: { existingId: existing?.id || null, generic, strength, form, values },
    });
  });
  return { columns, problems, rows };
}

// body: { rows, dryRun?, fileName?, fingerprint? } — what the import screen sends.
async function importDrugs(business, user, body) {
  requireClinic(business);
  await access.require(business, 'patients.edit_clinical');
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
      const { existingId, generic, strength, form, values } = row.write;
      if (!existingId) {
        await db.query(`INSERT INTO health_clinic_drugs(business_id,generic_name,strength,form,brand_names,route,usual_dose,usual_frequency,max_daily_amount,max_daily_unit,allergy_group,active,
          created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`, [business.id, generic, strength, form, values.brand_names || null, values.route || null,
          values.usual_dose || null, values.usual_frequency || null, values.max_daily_amount ?? null, values.max_daily_unit ?? null, values.allergy_group || null, values.active ?? true, user.id]);
      } else {
        const set = Object.keys(values);
        await db.query(`UPDATE health_clinic_drugs SET ${set.map((key, at) => `${key}=$${at + 3}`).join(',')},updated_by=$${set.length + 3},updated_at=now() WHERE business_id=$1 AND id=$2`,
          [business.id, existingId, ...set.map((key) => values[key]), user.id]);
      }
    }
    await repo.audit(db, business.id, user.id, 'clinic_drug.imported', business.id, { file: fileName || 'Spreadsheet import', created: summary.created, updated: summary.updated, unchanged: summary.unchanged });
    return summary;
  });
}

// --- The prescription's lines and their warnings --------------------------------------------

// The prescription as sent: up to 30 lines, each a medicine of the list
// (drugId) or one written by hand, and the doctor's reason for each warning
// they go on with (reasons: { allergy, same_medicine, same_group, dose_over_max }).
function readItems(value) {
  const items = v.requiredArray(value, 'Prescription');
  if (items.length > 30) fail('A prescription has at most 30 medicines');
  return items.map((item, index) => {
    const reasons = {};
    if (item?.reasons !== undefined && item.reasons !== null) {
      if (typeof item.reasons !== 'object' || Array.isArray(item.reasons)) fail(`Medicine ${index + 1}: the reasons are one for each warning`);
      for (const kind of rules.KINDS) {
        const reason = text(item.reasons[kind], 'Reason to go on', 300);
        if (reason) reasons[kind] = reason;
      }
    }
    return {
      drugId: item?.drugId === undefined || item?.drugId === null || item?.drugId === '' ? null : id(item.drugId, `Medicine ${index + 1}`),
      drugName: v.requiredString(item?.drugName ?? (item?.drugId ? '-' : undefined), `Medicine ${index + 1}`, 150), strength: text(item.strength, 'Strength', 60), dose: text(item.dose, 'Dose', 60),
      frequency: text(item.frequency, 'How often', 60), duration: text(item.duration, 'For how long', 60), instructions: text(item.instructions, 'Instructions', 200), reasons,
    };
  });
}

// Each line with its medicine of the list (a line of the list takes the
// list's generic name, and its strength when none is given) and the warnings
// it raises for this patient, each with the reason given for it (or null).
async function prepare(db, business, contactId, items) {
  const list = await repo.all(db, `SELECT id,generic_name,brand_names,strength,form,route,usual_dose,usual_frequency,max_daily_amount,max_daily_unit,allergy_group,active
    FROM health_clinic_drugs WHERE business_id=$1`, [business.id]);
  const card = await repo.one(db, 'SELECT allergies FROM health_patient_clinical WHERE business_id=$1 AND contact_id=$2', [business.id, contactId]);
  const byId = new Map(list.map((drug) => [String(drug.id), drug]));
  const lines = items.map((item, index) => {
    if (!item.drugId) return { ...item, drug: null };
    const drug = byId.get(String(item.drugId));
    if (!drug) fail(`Medicine ${index + 1} is not on the clinic's drug list`, 404);
    return { ...item, drugName: drug.generic_name, strength: item.strength || drug.strength, drug };
  });
  const warnings = rules.checkPrescription(lines, { allergies: card?.allergies || '', list });
  return lines.map((line, index) => ({ ...line, warnings: warnings.filter((w) => w.line === index).map((w) => ({ kind: w.kind, message: w.message, reason: line.reasons?.[w.kind] || null })) }));
}

// A warning with no reason stops the save: the doctor gives one, or changes the line.
function requireAnswers(lines) {
  const open = lines.flatMap((line, index) => line.warnings.filter((w) => !w.reason).map((w) => ({ line: index, kind: w.kind, message: w.message, drug: line.drugName })));
  if (open.length) {
    fail(open.length === 1 ? `${open[0].message} Give your reason to go on, or change the prescription.`
      : `The prescription has ${open.length} warnings: give your reason to go on with each, or change the prescription.`, 409, { reason: 'prescription_warnings', warnings: open });
  }
}

// The warnings a prescription would raise, before it is saved (nothing is
// written): what the consultation shows as the doctor writes.
async function check(business, visitId, body) {
  requireClinic(business);
  await access.require(business, 'patients.edit_clinical');
  const visit = await repo.one(repo.pool, 'SELECT id,contact_id,location_id FROM health_visits WHERE business_id=$1 AND id=$2', [business.id, id(visitId, 'Visit')]);
  if (!visit) fail('Visit not found', 404);
  access.requireLocation(business, visit.location_id);
  const lines = await prepare(repo.pool, business, visit.contact_id, readItems(body.prescription ?? []));
  return { warnings: lines.flatMap((line, index) => line.warnings.map(({ kind, message }) => ({ line: index, kind, message }))) };
}

module.exports = { create, update, picker, importGuide, importDrugs, readItems, prepare, requireAnswers, check };
