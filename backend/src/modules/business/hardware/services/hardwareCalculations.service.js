const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const maths = require('./hardwareCalculatorMaths');

// Material calculators (module "hardware_calculators"): tiles, paint,
// brickwork, concrete, plaster and steel, worked out by the server
// (hardwareCalculatorMaths.js) on Quick bill and on quotations. `calculate`
// answers the dialog as it is typed, with what each material comes to in the
// unit an item is sold in; a quotation or a bill keeps the workings it was
// made with (hardware_calculations): what was typed, every assumption, the
// result and the lines the calculator put on, worked out again by the server
// when they are saved. Estimates for the customer, not engineering.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const LITRES_PER_CFT = 28.316846592;
// The most workings one quotation or bill keeps from one save.
const MOST = 10;

function requireCalculators(business) {
  if (business.business_type !== 'hardware') fail('The material calculators belong to hardware shops', 404);
  if (!business.modules.includes('hardware_calculators')) fail('Material calculators is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
}

// The calculator's own words: a refusal is the person's to fix.
function work(kind, inputs, assumptions) {
  try {
    return maths.calculate(kind, inputs, assumptions);
  } catch (error) {
    if (error instanceof maths.CalculatorError) fail(error.message);
    throw error;
  }
}

// What `amount` of a material comes to in the unit an item is kept in, up to
// the unit's decimals; null when the unit cannot hold it (sand by the bag).
function inUnit(material, unit) {
  const factor = Number(unit.factor_to_base || 1);
  // Up to the unit's decimals, once the factor's own last places (kept to six) are rounded away.
  const round = (value) => { const scale = 10 ** Number(unit.decimals || 0); return Math.ceil(Math.round(value * scale * 1e6) / 1e6 - 1e-6) / scale; };
  const { measure, amount } = material;
  if (measure === 'bags') {
    if (unit.kind === 'count') return round(amount);
    if (unit.kind === 'weight' && (unit.base_unit_code || unit.code) === 'kg') return round((amount * material.bagKg) / factor);
    return null;
  }
  if (measure === 'bricks' || measure === 'units') return unit.kind === 'count' ? round(amount) : null;
  if (measure === 'cft') return unit.kind === 'volume' && (unit.base_unit_code || unit.code) === 'litre' ? round((amount * LITRES_PER_CFT) / factor) : null;
  if (measure === 'kg') {
    if (unit.kind === 'weight' && (unit.base_unit_code || unit.code) === 'kg') return round(amount / factor);
    if (unit.kind === 'count') return round(material.bars);
    return null;
  }
  return null;
}

// body: { kind, inputs, assumptions?, items?: { <material>: skuId } } — the
// materials are cement, sand, aggregate, bricks, tiles and steel_<diameter>.
// Answers the working, and for each item chosen the quantity to put on in
// its own unit (or why it cannot be).
async function calculate(business, body) {
  requireCalculators(business);
  await access.require(business, 'catalog.view');
  const worked = work(v.requiredString(body.kind, 'Calculator', 20), body.inputs, body.assumptions || {});
  const wanted = body.items && typeof body.items === 'object' && !Array.isArray(body.items) ? body.items : {};
  const lines = [], unfit = [];
  for (const material of maths.materials(worked)) {
    if (wanted[material.material] === undefined || wanted[material.material] === null || wanted[material.material] === '') continue;
    const sku = await repo.one(repo.pool, `SELECT s.id,s.label,s.unit,u.name AS unit_name,u.kind,u.decimals,u.base_unit_code,u.factor_to_base,u.code FROM catalog_skus s
      JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
      WHERE s.business_id=$1 AND s.id=$2 AND s.active AND p.active AND p.kind='goods'`, [business.id, id(wanted[material.material], 'Item')]);
    if (!sku) fail('Item not found', 404);
    const quantity = inUnit(material, sku);
    if (quantity === null || quantity <= 0) unfit.push({ material: material.material, skuId: Number(sku.id), label: sku.label, unit: sku.unit_name });
    else lines.push({ material: material.material, skuId: Number(sku.id), label: sku.label, unit: sku.unit, unitName: sku.unit_name, quantity: String(quantity) });
  }
  return { ...worked, materials: maths.materials(worked), lines, unfit };
}

// The workings sent with a quotation or a bill: [{ kind, inputs, assumptions,
// added?: [{ skuId, quantity }] }], each worked out again here. Left out: none.
function read(value) {
  if (value === undefined || value === null) return [];
  const list = v.requiredArray(value, 'Calculator workings');
  if (list.length > MOST) fail(`Keep at most ${MOST} calculator workings at once`);
  return list.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('Each calculator working must be an object');
    const worked = work(v.requiredString(entry.kind, 'Calculator', 20), entry.inputs, entry.assumptions || {});
    const added = entry.added === undefined || entry.added === null ? [] : v.requiredArray(entry.added, 'What the calculator added');
    if (added.length > 20) fail('A calculator adds at most 20 lines');
    return { ...worked, added: added.map((line) => ({ skuId: id(line?.skuId, 'Item'), quantity: String(line?.quantity ?? '').slice(0, 20) })) };
  });
}

async function save(db, business, user, list, { quotationId = null, revision = null, documentId = null }) {
  if (!list.length) return;
  requireCalculators(business);
  for (const worked of list) {
    if (worked.added.length) {
      const known = await repo.one(db, 'SELECT count(*)::int AS n FROM catalog_skus WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, [...new Set(worked.added.map((l) => l.skuId))]]);
      if (known.n !== new Set(worked.added.map((l) => l.skuId)).size) fail('Item not found', 404);
    }
    await db.query('INSERT INTO hardware_calculations(business_id,quotation_id,revision,document_id,kind,working,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [business.id, quotationId, revision, documentId, worked.kind, JSON.stringify({ inputs: worked.inputs, assumptions: worked.assumptions, result: worked.result,
        materials: maths.materials(worked), added: worked.added }), user.id]);
  }
}
const saveForQuotation = (db, business, user, quotation, list) => save(db, business, user, list, { quotationId: quotation.id, revision: quotation.revision });
const saveForDocument = (db, business, user, document, list) => save(db, business, user, list, { documentId: document.id });

const shownSql = `SELECT c.id,c.kind,c.revision,c.working,c.created_at,u.name AS created_by_name FROM hardware_calculations c JOIN users u ON u.id=c.created_by`;
const ofQuotation = (db, business, quotationId) => repo.all(db, `${shownSql} WHERE c.business_id=$1 AND c.quotation_id=$2 ORDER BY c.id`, [business.id, quotationId]);
const ofDocument = (db, business, documentId) => repo.all(db, `${shownSql} WHERE c.business_id=$1 AND c.document_id=$2 ORDER BY c.id`, [business.id, documentId]);

module.exports = { requireCalculators, calculate, read, saveForQuotation, saveForDocument, ofQuotation, ofDocument };
