const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const numbering = require('../../core/services/businessNumbering');
const core = require('../../core/services/business.service');
const { applyAdjustment, lockLot } = require('../../core/services/businessReturns.service');
const { split } = require('../../retail/services/businessOffers');
const { isOffcut } = require('./weightOffcuts');

// Meat, seafood and other weight-based shops: cutting /
// processing with yield, yield templates, daily wastage, stock by weight and
// the yield and wastage reports. See "Weight-based shops" in
// docs/BUSINESS_PLATFORM_DATA_MODEL.md.
//
// When stock moves: a cutting batch takes the input weight out of its lot
// and puts each cut into stock in the same transaction; a wastage entry takes
// the weight out at once. Both are written as reasoned stock corrections
// (business_stock_adjustments), never as sales, so the ledger keeps one
// source per movement. Stock can never go below zero (the correction refuses).
// Quantities are thousandths (grams of a kg), money is integer paise.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const optionalId = (value, name) => (value === undefined || value === null || value === '' ? null : id(value, name));
const milli = (value) => Math.round(Number(value) * 1000);
const paise = (value) => Math.round(Number(value) * 100);
const rupees = (p) => (p / 100).toFixed(2);
const qty = (m) => (m / 1000).toFixed(3);
const divide = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
const derivedKey = (base, part) => {
  const hex = crypto.createHash('sha256').update(`${base}:${part}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const REASONS = { trimming: 'Trimming', spoiled: 'Spoiled', unsold: 'Unsold / past its best', drip_loss: 'Drip / moisture loss', damaged: 'Damaged', other: 'Other' };
const requireModule = (business, code, name) => {
  if (!business.modules.includes(code)) fail(`${name} is not switched on for this business. An owner can turn it on in Settings › Business tools.`, 403);
};
// Thousandths of a kilogram in one stock unit (kg = 1000, g = 1).
const kgFactor = (sku) => (sku.unit_kind === 'weight' ? (sku.base_unit_code ? Number(sku.factor_to_base) : 1) : null);
const toKgMilli = (quantityMilli, factor) => Math.round(quantityMilli * factor);
const SKU_SQL = `SELECT s.*,p.kind,p.active AS product_active,u.kind AS unit_kind,u.decimals AS unit_decimals,u.name AS unit_name,u.base_unit_code,u.factor_to_base
  FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
  JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit WHERE s.business_id=$1 AND s.id=$2`;

function readQuantity(value, name, unit) {
  const number = core.decimal(value, name, 3, 0.001, 100000);
  if (Number(unit.unit_decimals) === 0 && !Number.isInteger(number)) fail(`${name} must be a whole number of ${String(unit.unit_name).toLowerCase()}`);
  return milli(number);
}

// --- Lists -------------------------------------------------------------------------------

const KG = (alias) => `(CASE WHEN ${alias}.kind='weight' THEN COALESCE(${alias}.factor_to_base,1) END)`;
repo.addLists({
  'weight-stock': {
    sql: `SELECT s.id AS sku_id,s.id||'-'||loc.id AS id,loc.id AS location_id,loc.name AS location_name,s.code,s.label,s.unit,s.price,s.reorder_level,s.tracking,
      COALESCE(c.name,p.category) AS category,${KG('u')} AS kg_factor,
      COALESCE(sum(l.quantity),0) AS on_hand,
      COALESCE(sum(l.quantity),0)*${KG('u')} AS on_hand_kg,
      COALESCE(sum(l.quantity*l.unit_cost),0)::numeric(16,2) AS value,
      CASE WHEN COALESCE(sum(l.quantity),0)>0 THEN (sum(l.quantity*l.unit_cost)/sum(l.quantity))::numeric(14,2) END AS average_cost,
      min(l.expires_on) FILTER (WHERE l.quantity>0) AS next_expiry,
      (SELECT COALESCE(sum(dl.quantity),0) FROM business_document_lines dl JOIN business_documents d ON d.business_id=dl.business_id AND d.id=dl.document_id
        WHERE dl.business_id=s.business_id AND dl.sku_id=s.id AND d.kind='sale' AND d.location_id=loc.id AND d.created_at > now() - interval '7 days') AS sold_7d,
      (SELECT COALESCE(sum(w.quantity),0) FROM weight_wastage_entries w WHERE w.business_id=s.business_id AND w.sku_id=s.id AND w.location_id=loc.id
        AND w.created_at > now() - interval '7 days') AS wasted_7d,
      (SELECT COALESCE(sum(o.quantity),0) FROM weight_processing_outputs o JOIN weight_processing_batches pb ON pb.business_id=o.business_id AND pb.id=o.batch_id
        WHERE o.business_id=s.business_id AND o.output_sku_id=s.id AND pb.location_id=loc.id AND pb.created_at > now() - interval '7 days') AS cut_7d,
      (SELECT COALESCE(sum(pb.input_quantity),0) FROM weight_processing_batches pb WHERE pb.business_id=s.business_id AND pb.input_sku_id=s.id AND pb.location_id=loc.id
        AND pb.created_at > now() - interval '7 days') AS cut_used_7d,
      (COALESCE(sum(l.quantity),0) <= s.reorder_level AND s.reorder_level > 0) AS low
      FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
      LEFT JOIN catalog_categories c ON c.business_id=p.business_id AND c.id=p.category_id
      JOIN business_locations loc ON loc.business_id=s.business_id AND loc.active
      LEFT JOIN business_stock_lots l ON l.business_id=s.business_id AND l.sku_id=s.id AND l.location_id=loc.id
      WHERE s.business_id=$1 AND p.kind='goods' AND s.active AND u.kind='weight'
      GROUP BY s.id,loc.id,loc.name,p.category,c.name,u.kind,u.factor_to_base`,
    search: ['label', 'code', 'category', 'location_name'], filters: { location: 'location_id', low: 'low' }, order: 'category NULLS LAST,label,location_id',
  },
  'weight-yield-templates': {
    sql: `SELECT t.*,s.label AS input_label,s.unit AS input_unit,
      COALESCE((SELECT json_agg(json_build_object('sku_id',o.output_sku_id,'label',x.label,'unit',x.unit,'expected_percent',o.expected_percent) ORDER BY o.expected_percent DESC)
        FROM weight_yield_template_outputs o JOIN catalog_skus x ON x.business_id=o.business_id AND x.id=o.output_sku_id
        WHERE o.business_id=t.business_id AND o.template_id=t.id),'[]') AS outputs,
      COALESCE((SELECT sum(o.expected_percent) FROM weight_yield_template_outputs o WHERE o.business_id=t.business_id AND o.template_id=t.id),0) AS expected_yield,
      (SELECT count(*)::int FROM weight_processing_batches pb WHERE pb.business_id=t.business_id AND pb.template_id=t.id) AS batches
      FROM weight_yield_templates t JOIN catalog_skus s ON s.business_id=t.business_id AND s.id=t.input_sku_id WHERE t.business_id=$1`,
    search: ['name', 'input_label'], filters: { active: 'active', input: 'input_sku_id' }, order: 'active DESC,name',
  },
  'weight-processing': {
    sql: `SELECT pb.*,loc.name AS location_name,u.name AS created_by_name,t.name AS template_name,l.lot_code AS input_lot_code,sup.name AS supplier_name,
      round(100*pb.output_kg/pb.input_kg,2) AS yield_percent,
      (SELECT sum(o.expected_percent) FROM weight_yield_template_outputs o WHERE o.business_id=pb.business_id AND o.template_id=pb.template_id) AS expected_yield,
      CASE WHEN pb.output_kg>0 THEN round(pb.input_value/pb.output_kg,2) END AS cost_per_usable_kg,
      COALESCE((SELECT json_agg(json_build_object('sku_id',o.output_sku_id,'label',o.label,'unit',o.unit,'quantity',o.quantity,'kg',o.kg,'cost_share',o.cost_share,
        'unit_cost',o.unit_cost,'expected_percent',o.expected_percent,'lot_id',o.lot_id,'offcut',o.offcut) ORDER BY o.kg DESC)
        FROM weight_processing_outputs o WHERE o.business_id=pb.business_id AND o.batch_id=pb.id),'[]') AS outputs
      FROM weight_processing_batches pb JOIN business_locations loc ON loc.business_id=pb.business_id AND loc.id=pb.location_id
      JOIN users u ON u.id=pb.created_by
      JOIN business_stock_lots l ON l.business_id=pb.business_id AND l.id=pb.input_lot_id
      LEFT JOIN business_contacts sup ON sup.business_id=pb.business_id AND sup.id=pb.supplier_id
      LEFT JOIN weight_yield_templates t ON t.business_id=pb.business_id AND t.id=pb.template_id WHERE pb.business_id=$1`,
    search: ['batch_no', 'input_label', 'notes', 'location_name', 'cut_by', 'supplier_name'], date: 'created_at',
    filters: { location: 'location_id', input: 'input_sku_id', id: 'id', template: 'template_id', supplier: 'supplier_id', cutter: 'cut_by' }, order: 'id DESC',
  },
  'weight-wastage': {
    sql: `SELECT w.*,loc.name AS location_name,u.name AS created_by_name,l.lot_code
      FROM weight_wastage_entries w JOIN business_locations loc ON loc.business_id=w.business_id AND loc.id=w.location_id
      JOIN users u ON u.id=w.created_by JOIN business_stock_lots l ON l.business_id=w.business_id AND l.id=w.lot_id WHERE w.business_id=$1`,
    search: ['label', 'note', 'reason', 'location_name', 'lot_code'], date: 'created_at', filters: { location: 'location_id', reason: 'reason', sku: 'sku_id' }, order: 'id DESC',
  },
});

// --- Yield templates --------------------------------------------------------------------------

async function readTemplate(db, business, body) {
  const name = v.requiredString(body.name, 'Template name', 150);
  const input = await repo.one(db, SKU_SQL, [business.id, id(body.inputSkuId, 'Whole item')]);
  if (!input || input.unit_kind !== 'weight' || input.kind !== 'goods' || input.tracking === 'serial') fail('Choose a whole item stocked by weight (kg or g)');
  const list = v.requiredArray(body.outputs, 'Cuts');
  if (!list.length || list.length > 20) fail('A template has between 1 and 20 cuts');
  const outputs = list.map((o) => ({ skuId: id(o?.skuId, 'Cut'), percent: core.decimal(o?.expectedPercent, 'Expected %', 2, 0.01, 100) }));
  if (new Set(outputs.map((o) => o.skuId)).size !== outputs.length) fail('A cut may only appear once');
  if (outputs.some((o) => o.skuId === Number(input.id))) fail('The whole item cannot be one of its own cuts');
  if (outputs.reduce((s, o) => s + paise(o.percent), 0) > 10000) fail('The expected cuts add up to more than 100% of the input');
  return { name, input, outputs, active: v.requiredBoolean(body.active, 'Active', true) };
}
async function createTemplate(business, user, body) {
  requireModule(business, 'processing', 'Cutting & yield');
  await access.require(business, 'processing.edit');
  return repo.transaction(async (db) => {
    const t = await readTemplate(db, business, body);
    const row = await repo.one(db, `INSERT INTO weight_yield_templates(business_id,name,input_sku_id,active,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5) RETURNING *`,
      [business.id, t.name, t.input.id, t.active, user.id]);
    for (const o of t.outputs) await db.query('INSERT INTO weight_yield_template_outputs(business_id,template_id,output_sku_id,expected_percent) VALUES($1,$2,$3,$4)', [business.id, row.id, o.skuId, o.percent]);
    await repo.audit(db, business.id, user.id, 'yield_template.created', row.id, { name: t.name });
    return row;
  });
}
async function updateTemplate(business, user, templateId, body) {
  requireModule(business, 'processing', 'Cutting & yield');
  await access.require(business, 'processing.edit');
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM weight_yield_templates WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(templateId, 'Template')]);
    if (!current) fail('Template not found', 404);
    if (Object.keys(body).length === 1 && body.active !== undefined) {
      const row = await repo.one(db, 'UPDATE weight_yield_templates SET active=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *',
        [business.id, current.id, v.requiredBoolean(body.active, 'Active'), user.id]);
      await repo.audit(db, business.id, user.id, 'yield_template.updated', row.id, { active: row.active });
      return row;
    }
    const t = await readTemplate(db, business, body);
    const row = await repo.one(db, 'UPDATE weight_yield_templates SET name=$3,input_sku_id=$4,active=$5,updated_by=$6,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *',
      [business.id, current.id, t.name, t.input.id, t.active, user.id]);
    await db.query('DELETE FROM weight_yield_template_outputs WHERE business_id=$1 AND template_id=$2', [business.id, current.id]);
    for (const o of t.outputs) await db.query('INSERT INTO weight_yield_template_outputs(business_id,template_id,output_sku_id,expected_percent) VALUES($1,$2,$3,$4)', [business.id, row.id, o.skuId, o.percent]);
    await repo.audit(db, business.id, user.id, 'yield_template.updated', row.id, { name: t.name });
    return row;
  });
}

// --- Cutting / processing ------------------------------------------------------------------------

// body: { inputLotId, inputQuantity, templateId?, outputs: [{ skuId, quantity }], notes?, requestKey }
// The input's cost is carried by the cuts in proportion to their selling
// value (quantity × list price); with no prices, in proportion to weight.
// Cuts tracked by batch get a batch named after the cutting number, with the
// input's expiry; other cuts join their item's untracked stock at the
// input's location (average cost).
async function processBatch(business, user, body) {
  requireModule(business, 'processing', 'Cutting & yield');
  await access.require(business, 'processing.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const list = v.requiredArray(body.outputs, 'Cuts');
  if (!list.length || list.length > 20) fail('Record between 1 and 20 cuts');
  const notes = v.optionalString(body.notes, 'Notes', 500);
  // Who cut it (the yield report compares cutters).
  const cutBy = v.optionalString(body.cutBy, 'Cut by', 100);
  const cutToOrder = v.requiredBoolean(body.cutToOrder, 'Cut to order', false);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM weight_processing_batches WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return old;
    }
    const lot = await lockLot(db, business.id, id(body.inputLotId, 'Input batch'));
    if (!lot) fail('Input stock not found', 404);
    const input = await repo.one(db, SKU_SQL, [business.id, lot.sku_id]);
    if (input.unit_kind !== 'weight' || input.kind !== 'goods' || input.tracking === 'serial') fail(`${input.label} is not stocked by weight, so it cannot be cut by weight`);
    const today = await repo.one(db, 'SELECT (now() AT TIME ZONE timezone)::date AS day FROM businesses WHERE id=$1', [business.id]);
    if (lot.expires_on && lot.expires_on < today.day) fail(`This batch of ${input.label} expired on ${lot.expires_on}. Record it as wastage instead.`, 409);
    const inputMilli = readQuantity(body.inputQuantity, 'Input weight', input);
    if (inputMilli > milli(lot.quantity)) fail(`Only ${quantityText(milli(lot.quantity), input.unit)} of ${input.label} is in this batch`, 409);
    const inputKg = toKgMilli(inputMilli, kgFactor(input));
    let template = null;
    const templateId = optionalId(body.templateId, 'Template');
    if (templateId) {
      template = await repo.one(db, 'SELECT * FROM weight_yield_templates WHERE business_id=$1 AND id=$2', [business.id, templateId]);
      if (!template || Number(template.input_sku_id) !== Number(input.id)) fail('That template is for another item', 404);
    }
    const expected = template ? new Map((await repo.all(db, 'SELECT output_sku_id,expected_percent FROM weight_yield_template_outputs WHERE business_id=$1 AND template_id=$2', [business.id, template.id]))
      .map((r) => [Number(r.output_sku_id), r.expected_percent])) : new Map();
    const outputs = [];
    for (const entry of list) {
      const sku = await repo.one(db, SKU_SQL, [business.id, id(entry?.skuId, 'Cut')]);
      if (!sku || !sku.active || !sku.product_active) fail('Cut not found', 404);
      if (sku.kind !== 'goods' || sku.tracking === 'serial') fail(`${sku.label} is not stocked loose or by weight`);
      if (Number(sku.id) === Number(input.id)) fail('The input cannot be one of its own cuts');
      if (outputs.some((o) => Number(o.sku.id) === Number(sku.id))) fail('Each cut may only appear once');
      const quantityMilli = readQuantity(entry.quantity, `${sku.unit_kind === 'weight' ? 'Weight' : 'Packs'} of ${sku.label}`, sku);
      let kgMilli;
      if (sku.unit_kind === 'weight') kgMilli = toKgMilli(quantityMilli, kgFactor(sku));
      else {
        // Repacking into pouches sold by the piece (a 250 g pack = 0.25 kg each).
        const remembered = await repo.one(db, 'SELECT pack_kg FROM weight_pack_sizes WHERE business_id=$1 AND sku_id=$2', [business.id, sku.id]);
        const packKg = entry.packKg === undefined || entry.packKg === null || entry.packKg === '' ? remembered?.pack_kg : core.decimal(entry.packKg, `Weight of one ${sku.label}`, 3, 0.001, 1000);
        if (!packKg) fail(`Say how much one ${sku.label} weighs (pack weight in kg)`);
        kgMilli = Math.round((quantityMilli * milli(packKg)) / 1000);
        if (!remembered || Number(remembered.pack_kg) !== Number(packKg)) {
          await db.query(`INSERT INTO weight_pack_sizes(business_id,sku_id,pack_kg,updated_by) VALUES($1,$2,$3,$4)
            ON CONFLICT(business_id,sku_id) DO UPDATE SET pack_kg=EXCLUDED.pack_kg,updated_by=EXCLUDED.updated_by,updated_at=now()`, [business.id, sku.id, packKg, user.id]);
        }
      }
      outputs.push({ sku, quantityMilli, kgMilli, expected: expected.get(Number(sku.id)) || null });
    }
    const outputKg = outputs.reduce((s, o) => s + o.kgMilli, 0);
    if (outputKg <= 0) fail('The cuts must weigh something');
    if (outputKg > inputKg) fail(`The cuts weigh ${qty(outputKg)} kg, more than the ${qty(inputKg)} kg cut. Check the weights.`);
    const costTenThousandths = Math.round(Number(lot.unit_cost) * 10000);
    const inputValue = divide(BigInt(inputMilli) * BigInt(costTenThousandths), 100000n);
    const values = outputs.map((o) => Number(BigInt(o.quantityMilli) * BigInt(paise(o.sku.price))));
    const weights = values.some((x) => x > 0) ? values : outputs.map((o) => o.kgMilli);
    split(inputValue, weights).forEach((share, i) => { outputs[i].share = share; });
    // A cut priced below what the whole item cost a kilo is an offcut (weightOffcuts.js).
    const inclusive = (await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]))?.tax_mode === 'inclusive';
    for (const o of outputs) {
      o.offcut = isOffcut({ pricePaise: paise(o.sku.price), taxRate: o.sku.tax_rate, inclusive, quantityMilli: o.quantityMilli, kgMilli: o.kgMilli,
        inputValuePaise: inputValue, inputKgMilli: inputKg });
    }

    // The supplier of the input: the purchase that brought this batch in (latest).
    const supplier = await repo.one(db, `SELECT d.contact_id FROM business_stock_movements m JOIN business_documents d ON d.business_id=m.business_id AND d.id=m.document_id
      WHERE m.business_id=$1 AND m.lot_id=$2 AND d.kind='purchase' AND d.contact_id IS NOT NULL ORDER BY m.id DESC LIMIT 1`, [business.id, lot.id]);
    const number = await numbering.nextNumber(db, business.id, lot.location_id, 'processing', user.id);
    const inputAdjustment = await applyAdjustment(db, business, user, lot, -(inputMilli / 1000),
      `Cut into ${outputs.map((o) => o.sku.label).join(', ')} (${number.number})`.slice(0, 300), derivedKey(requestKey, 'input'));
    const batch = await repo.one(db, `INSERT INTO weight_processing_batches(business_id,batch_no,series_id,location_id,template_id,input_sku_id,input_lot_id,input_label,input_unit,
      input_quantity,input_unit_cost,input_value,input_kg,output_kg,loss_kg,input_adjustment_id,notes,request_key,request_hash,created_by,cut_by,supplier_id,cut_to_order)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
    [business.id, number.number, number.seriesId, lot.location_id, template?.id || null, input.id, lot.id, input.label, input.unit,
      qty(inputMilli), lot.unit_cost, rupees(inputValue), qty(inputKg), qty(outputKg), qty(inputKg - outputKg), inputAdjustment.id, notes, requestKey, hash, user.id,
      cutBy, supplier?.contact_id || null, cutToOrder]);
    for (const [n, o] of outputs.entries()) {
      const lotCode = o.sku.tracking === 'batch' ? number.number : '';
      const expiresOn = o.sku.tracking === 'batch' ? lot.expires_on || null : null;
      const unitCost = o.share / 100 / (o.quantityMilli / 1000);
      let target = await repo.one(db, 'SELECT * FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=$3 AND lot_code=$4 FOR UPDATE',
        [business.id, lot.location_id, o.sku.id, lotCode]);
      if (!target) {
        target = await repo.one(db, `INSERT INTO business_stock_lots(business_id,location_id,sku_id,lot_code,expires_on,quantity,unit_cost) VALUES($1,$2,$3,$4,$5,0,$6) RETURNING *`,
          [business.id, lot.location_id, o.sku.id, lotCode, expiresOn, unitCost.toFixed(4)]);
      } else {
        // Weighted average cost with what is already there.
        await db.query(`UPDATE business_stock_lots SET unit_cost=CASE WHEN quantity+$3>0 THEN (quantity*unit_cost+$3*$4)/(quantity+$3) ELSE $4 END WHERE business_id=$1 AND id=$2`,
          [business.id, target.id, qty(o.quantityMilli), unitCost.toFixed(4)]);
      }
      const locked = await lockLot(db, business.id, target.id);
      const adjustment = await applyAdjustment(db, business, user, locked, o.quantityMilli / 1000, `Cut from ${input.label} (${number.number})`.slice(0, 300), derivedKey(requestKey, `output-${n}`));
      await db.query(`INSERT INTO weight_processing_outputs(business_id,batch_id,output_sku_id,label,unit,lot_id,quantity,kg,cost_share,unit_cost,expected_percent,adjustment_id,offcut)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [business.id, batch.id, o.sku.id, o.sku.label, o.sku.unit, target.id, qty(o.quantityMilli), qty(o.kgMilli),
        rupees(o.share), unitCost.toFixed(4), o.expected, adjustment.id, o.offcut]);
    }
    await repo.audit(db, business.id, user.id, 'processing.posted', batch.id, { batchNo: batch.batch_no, inputKg: batch.input_kg, outputKg: batch.output_kg, lossKg: batch.loss_kg,
      ...(cutBy ? { cutBy } : {}), ...(cutToOrder ? { cutToOrder } : {}) });
    await repo.event(db, business.id, user.id, 'processing.posted', 'processing_batch', batch.id, {
      batchNo: batch.batch_no, locationId: lot.location_id, input: { skuId: input.id, lotId: lot.id, quantity: batch.input_quantity },
      outputs: outputs.map((o) => ({ skuId: o.sku.id, quantity: qty(o.quantityMilli), costShare: rupees(o.share) })), lossKg: batch.loss_kg,
    });
    return { ...batch, outputs: outputs.map((o) => ({ skuId: Number(o.sku.id), code: o.sku.code, label: o.sku.label, unit: o.sku.unit, quantity: qty(o.quantityMilli),
      lotCode: o.sku.tracking === 'batch' ? number.number : '' })) };
  });
}
const quantityText = (m, unit) => `${Number(qty(m))} ${unit}`;

async function batchDetail(business, batchId) {
  requireModule(business, 'processing', 'Cutting & yield');
  await access.require(business, 'processing.view');
  const result = await repo.page(business.id, 'weight-processing', 1, 0, { filters: { id: String(id(batchId, 'Cutting batch')) } });
  if (!result.items.length) fail('Cutting batch not found', 404);
  return result.items[0];
}

// --- Wastage -------------------------------------------------------------------------------------

// body: { lotId, quantity, reason, note?, requestKey }
async function recordWastage(business, user, body) {
  requireModule(business, 'wastage', 'Daily wastage');
  await access.require(business, 'wastage.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const reason = v.requiredEnum(body.reason, 'Reason', Object.keys(REASONS));
  const note = v.optionalString(body.note, 'Note', 300);
  if (reason === 'other' && !note) fail('Say what happened when the reason is "Other"');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM weight_wastage_entries WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return old;
    }
    const lot = await lockLot(db, business.id, id(body.lotId, 'Stock batch'));
    if (!lot) fail('Stock not found', 404);
    const sku = await repo.one(db, SKU_SQL, [business.id, lot.sku_id]);
    if (sku.kind !== 'goods' || sku.tracking === 'serial') fail('Record wastage of loose goods here; serial-numbered units are corrected one by one under Stock');
    const quantityMilli = readQuantity(body.quantity, 'Quantity wasted', sku);
    return wasteFromLot(db, business, user, { lot, sku, quantityMilli, reason, note, requestKey, hash });
  });
}

// Takes wasted weight out of one batch (inside the caller's transaction).
async function wasteFromLot(db, business, user, { lot, sku, quantityMilli, reason, note, requestKey, hash }) {
  {
    if (quantityMilli > milli(lot.quantity)) fail(`Only ${quantityText(milli(lot.quantity), sku.unit)} of ${sku.label} is in this batch`, 409);
    const factor = kgFactor(sku);
    const value = divide(BigInt(quantityMilli) * BigInt(Math.round(Number(lot.unit_cost) * 10000)), 100000n);
    const adjustment = await applyAdjustment(db, business, user, lot, -(quantityMilli / 1000), `Wastage: ${REASONS[reason]}${note ? ` — ${note}` : ''}`.slice(0, 300), derivedKey(requestKey, 'wastage'));
    const entry = await repo.one(db, `INSERT INTO weight_wastage_entries(business_id,location_id,sku_id,lot_id,label,unit,quantity,kg,reason,note,unit_cost,value,adjustment_id,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [business.id, lot.location_id, sku.id, lot.id, sku.label, sku.unit, qty(quantityMilli), factor ? qty(toKgMilli(quantityMilli, factor)) : null, reason, note,
      lot.unit_cost, rupees(value), adjustment.id, requestKey, hash, user.id]);
    await repo.audit(db, business.id, user.id, 'wastage.recorded', entry.id, { label: sku.label, quantity: entry.quantity, reason, value: entry.value });
    await repo.event(db, business.id, user.id, 'wastage.recorded', 'wastage_entry', entry.id, {
      skuId: sku.id, lotId: lot.id, locationId: lot.location_id, quantity: entry.quantity, kg: entry.kg, reason, value: entry.value,
    });
    return entry;
  }
}

// --- Reports -------------------------------------------------------------------------------------

function period(query) {
  const from = core.dateText(query.from, 'From date'), to = core.dateText(query.to, 'To date');
  if (to < from || Date.parse(to) - Date.parse(from) > 366 * 86400000) fail('Choose a date range of up to 367 days');
  return { from, to, location: optionalId(query.location, 'Location') };
}
// The supplier of a batch's whole item: kept on the batch when it was cut,
// otherwise (batches cut before that was kept) the purchase that brought its
// input batch in.
const SUPPLIER = (pb) => `COALESCE(${pb}.supplier_id,(SELECT d.contact_id FROM business_stock_movements m JOIN business_documents d ON d.business_id=m.business_id AND d.id=m.document_id
  WHERE m.business_id=${pb}.business_id AND m.lot_id=${pb}.input_lot_id AND d.kind='purchase' AND d.contact_id IS NOT NULL ORDER BY m.id DESC LIMIT 1))`;
const IN_PERIOD = (alias) => `${alias}.business_id=$1 AND (${alias}.created_at AT TIME ZONE b.timezone)::date BETWEEN $2::date AND $3::date AND ($4::bigint IS NULL OR ${alias}.location_id=$4)`;

async function yieldReport(business, query) {
  requireModule(business, 'processing', 'Cutting & yield');
  await access.require(business, 'reports.view');
  await access.require(business, 'processing.view');
  const { from, to, location } = period(query);
  // Filter by template, cutter and supplier; inputs are
  // grouped by template (whole item → cut), so curry-cut and boneless batches
  // of the same bird are never pooled into one meaningless yield.
  const template = optionalId(query.template, 'Template');
  const supplier = optionalId(query.supplier, 'Supplier');
  const cutter = typeof query.cutter === 'string' && query.cutter.trim() ? query.cutter.trim().slice(0, 100) : null;
  const values = [business.id, from, to, location, template, supplier, cutter];
  const FILTERS = `AND ($5::bigint IS NULL OR pb.template_id=$5) AND ($6::bigint IS NULL OR ${SUPPLIER('pb')}=$6) AND ($7::text IS NULL OR pb.cut_by ILIKE $7)`;
  const [inputs, cuts, days, cutters, suppliers, bySupplier] = await Promise.all([
    repo.all(repo.pool, `SELECT pb.input_sku_id,pb.template_id,max(pb.input_label) AS input_label,max(tp.name) AS template_name,
      COALESCE(max(tp.name),max(pb.input_label) || ' (no template)') AS label,count(*)::int AS batches,sum(pb.input_quantity) AS input_quantity,max(pb.input_unit) AS unit,
      sum(pb.input_kg) AS input_kg,sum(pb.output_kg) AS output_kg,sum(pb.loss_kg) AS loss_kg,sum(pb.input_value) AS input_value,
      round(100*sum(pb.output_kg)/NULLIF(sum(pb.input_kg),0),2) AS yield_percent,
      round(sum(pb.input_kg*t.expected)/NULLIF(sum(pb.input_kg) FILTER (WHERE t.expected IS NOT NULL),0),2) AS expected_percent,
      round(sum(pb.input_value)/NULLIF(sum(pb.output_kg),0),2) AS cost_per_usable_kg,
      round(sum(pb.input_value)/NULLIF(sum(pb.input_kg),0),2) AS cost_per_input_kg
      FROM weight_processing_batches pb JOIN businesses b ON b.id=pb.business_id
      LEFT JOIN weight_yield_templates tp ON tp.business_id=pb.business_id AND tp.id=pb.template_id
      LEFT JOIN LATERAL (SELECT sum(o.expected_percent) AS expected FROM weight_yield_template_outputs o WHERE o.business_id=pb.business_id AND o.template_id=pb.template_id) t ON true
      WHERE ${IN_PERIOD('pb')} ${FILTERS} GROUP BY pb.input_sku_id,pb.template_id ORDER BY sum(pb.input_kg) DESC`, values),
    repo.all(repo.pool, `SELECT o.output_sku_id,max(o.label) AS label,max(o.unit) AS unit,max(pb.input_label) AS from_label,count(*)::int AS batches,
      sum(o.quantity) AS quantity,sum(o.kg) AS kg,sum(o.cost_share) AS cost,round(sum(o.cost_share)/NULLIF(sum(o.kg),0),2) AS cost_per_kg,
      round(100*sum(o.kg)/NULLIF(sum(pb.input_kg),0),2) AS share_percent,round(avg(o.expected_percent),2) AS expected_percent
      FROM weight_processing_outputs o JOIN weight_processing_batches pb ON pb.business_id=o.business_id AND pb.id=o.batch_id JOIN businesses b ON b.id=pb.business_id
      WHERE ${IN_PERIOD('pb')} ${FILTERS} GROUP BY o.output_sku_id,pb.input_sku_id ORDER BY sum(o.kg) DESC`, values),
    repo.all(repo.pool, `SELECT (pb.created_at AT TIME ZONE b.timezone)::date::text AS day,count(*)::int AS batches,sum(pb.input_kg) AS input_kg,sum(pb.output_kg) AS output_kg,
      sum(pb.loss_kg) AS loss_kg,round(100*sum(pb.output_kg)/NULLIF(sum(pb.input_kg),0),2) AS yield_percent
      FROM weight_processing_batches pb JOIN businesses b ON b.id=pb.business_id WHERE ${IN_PERIOD('pb')} ${FILTERS} GROUP BY 1 ORDER BY 1 DESC`, values),
    repo.all(repo.pool, `SELECT DISTINCT pb.cut_by FROM weight_processing_batches pb WHERE pb.business_id=$1 AND pb.cut_by IS NOT NULL ORDER BY 1 LIMIT 50`, [business.id]),
    repo.all(repo.pool, `SELECT DISTINCT c.id,c.name FROM weight_processing_batches pb JOIN business_contacts c ON c.business_id=pb.business_id AND c.id=${SUPPLIER('pb')}
      WHERE pb.business_id=$1 ORDER BY c.name LIMIT 50`, [business.id]),
    // The average yield of each whole item by the supplier it was
    // bought from (weighted by kg: total cut ÷ total whole weight), so a
    // supplier whose birds dress out lighter shows up.
    repo.all(repo.pool, `SELECT ${SUPPLIER('pb')} AS supplier_id,COALESCE(max(c.name),'No purchase (opening stock)') AS supplier_name,pb.input_sku_id,max(pb.input_label) AS input_label,
      count(*)::int AS batches,sum(pb.input_kg) AS input_kg,sum(pb.output_kg) AS output_kg,sum(pb.loss_kg) AS loss_kg,
      round(100*sum(pb.output_kg)/NULLIF(sum(pb.input_kg),0),2) AS yield_percent,
      round(avg(100*pb.output_kg/NULLIF(pb.input_kg,0)),2) AS batch_average_percent,
      round(min(100*pb.output_kg/NULLIF(pb.input_kg,0)),2) AS worst_percent,round(max(100*pb.output_kg/NULLIF(pb.input_kg,0)),2) AS best_percent,
      round(sum(pb.input_kg*t.expected)/NULLIF(sum(pb.input_kg) FILTER (WHERE t.expected IS NOT NULL),0),2) AS expected_percent,
      round(sum(pb.input_value)/NULLIF(sum(pb.output_kg),0),2) AS cost_per_usable_kg
      FROM weight_processing_batches pb JOIN businesses b ON b.id=pb.business_id
      LEFT JOIN business_contacts c ON c.business_id=pb.business_id AND c.id=${SUPPLIER('pb')}
      LEFT JOIN LATERAL (SELECT sum(o.expected_percent) AS expected FROM weight_yield_template_outputs o WHERE o.business_id=pb.business_id AND o.template_id=pb.template_id) t ON true
      WHERE ${IN_PERIOD('pb')} ${FILTERS} GROUP BY 1,pb.input_sku_id ORDER BY max(pb.input_label),round(100*sum(pb.output_kg)/NULLIF(sum(pb.input_kg),0),2) DESC`, values),
  ]);
  // Each supplier against the item's average over all suppliers (points).
  for (const row of bySupplier) {
    const all = bySupplier.filter((r) => Number(r.input_sku_id) === Number(row.input_sku_id));
    const inKg = all.reduce((s, r) => s + milli(r.input_kg), 0), outKg = all.reduce((s, r) => s + milli(r.output_kg), 0);
    const average = inKg ? (outKg * 100) / inKg : null;
    row.item_average_percent = average === null ? null : average.toFixed(2);
    row.versus_average = average === null || row.yield_percent === null ? null : (Number(row.yield_percent) - average).toFixed(2);
  }
  // The shortfall against the template, in points and in rupees: the usable
  // kg not got (input kg × points short) at the cost of a usable kg.
  for (const row of inputs) {
    const short = row.expected_percent === null ? null : Number(row.expected_percent) - Number(row.yield_percent);
    row.short_points = short === null ? null : short.toFixed(2);
    row.short_kg = short === null || short <= 0 ? '0.000' : ((Number(row.input_kg) * short) / 100).toFixed(3);
    row.short_value = short === null || short <= 0 ? '0.00' : rupees(Math.round(Number(row.short_kg) * paise(row.cost_per_usable_kg || 0)));
  }
  const sum = (rows, key) => rows.reduce((s, r) => s + milli(r[key] || 0), 0);
  const inputKg = sum(inputs, 'input_kg'), outputKg = sum(inputs, 'output_kg');
  const offcuts = await offcutsRecovered(values.slice(0, 4));
  return {
    from, to, inputs, cuts, days, offcuts, cutters: cutters.map((c) => c.cut_by), suppliers, bySupplier,
    shortValue: rupees(inputs.reduce((s, r) => s + paise(r.short_value), 0)),
    totals: { batches: inputs.reduce((s, r) => s + r.batches, 0), inputKg: qty(inputKg), outputKg: qty(outputKg), lossKg: qty(inputKg - outputKg),
      yieldPercent: inputKg ? (Math.round((outputKg * 10000) / inputKg) / 100).toFixed(2) : null,
      inputValue: rupees(inputs.reduce((s, r) => s + paise(r.input_value), 0)) },
  };
}

// What offcuts brought in, from the bills: each sale line of an item whose
// latest cut at the bill's location, before the bill, was an offcut, at its
// value before GST less what was returned of it; by item (with what was cut
// as offcuts in the dates) and by the day billed, on the business's clock.
// values: [business, from, to, location].
async function offcutsRecovered(values) {
  const sold = `WITH sold AS (
      SELECT dl.sku_id,dl.label,dl.unit,d.id AS document_id,(d.created_at AT TIME ZONE b.timezone)::date AS day,
        dl.quantity-COALESCE(r.quantity,0) AS quantity,dl.net-COALESCE(r.net,0) AS value
      FROM business_document_lines dl JOIN business_documents d ON d.business_id=dl.business_id AND d.id=dl.document_id JOIN businesses b ON b.id=d.business_id
      LEFT JOIN LATERAL (SELECT sum(rl.quantity) AS quantity,sum(rl.net) AS net FROM business_return_lines rl WHERE rl.business_id=dl.business_id AND rl.line_id=dl.id) r ON true
      WHERE ${IN_PERIOD('d')} AND d.kind='sale'
        AND (SELECT o.offcut FROM weight_processing_outputs o JOIN weight_processing_batches pb ON pb.business_id=o.business_id AND pb.id=o.batch_id
          WHERE o.business_id=dl.business_id AND o.output_sku_id=dl.sku_id AND pb.location_id=d.location_id AND pb.created_at<=d.created_at
          ORDER BY pb.created_at DESC,pb.id DESC LIMIT 1))`;
  const [items, cut, days] = await Promise.all([
    repo.all(repo.pool, `${sold} SELECT sku_id,max(label) AS label,max(unit) AS unit,count(DISTINCT document_id)::int AS bills,sum(quantity) AS quantity,sum(value) AS recovered
      FROM sold GROUP BY sku_id`, values),
    repo.all(repo.pool, `SELECT o.output_sku_id AS sku_id,max(o.label) AS label,max(o.unit) AS unit,sum(o.quantity) AS cut_quantity,sum(o.kg) AS cut_kg
      FROM weight_processing_outputs o JOIN weight_processing_batches pb ON pb.business_id=o.business_id AND pb.id=o.batch_id JOIN businesses b ON b.id=pb.business_id
      WHERE ${IN_PERIOD('pb')} AND o.offcut GROUP BY o.output_sku_id`, values),
    repo.all(repo.pool, `${sold} SELECT day::text AS day,count(DISTINCT document_id)::int AS bills,sum(value) AS recovered FROM sold GROUP BY day ORDER BY day DESC`, values),
  ]);
  const bySku = new Map();
  for (const row of cut) bySku.set(Number(row.sku_id), { sku_id: Number(row.sku_id), label: row.label, unit: row.unit, cut_quantity: row.cut_quantity, cut_kg: row.cut_kg,
    bills: 0, quantity: '0.000', recovered: '0.00' });
  for (const row of items) {
    const was = bySku.get(Number(row.sku_id)) || { sku_id: Number(row.sku_id), label: row.label, unit: row.unit, cut_quantity: '0.000', cut_kg: '0.000' };
    bySku.set(Number(row.sku_id), { ...was, bills: row.bills, quantity: qty(milli(row.quantity)), recovered: rupees(paise(row.recovered)) });
  }
  const list = [...bySku.values()].sort((a, b) => paise(b.recovered) - paise(a.recovered) || String(a.label).localeCompare(String(b.label)));
  return {
    items: list,
    days: days.map((d) => ({ day: d.day, bills: d.bills, recovered: rupees(paise(d.recovered)) })),
    recovered: rupees(list.reduce((s, r) => s + paise(r.recovered), 0)),
  };
}

async function wastageReport(business, query) {
  requireModule(business, 'wastage', 'Daily wastage');
  await access.require(business, 'reports.view');
  await access.require(business, 'wastage.view');
  const { from, to, location } = period(query);
  const values = [business.id, from, to, location];
  const [items, reasons, days] = await Promise.all([
    repo.all(repo.pool, `WITH wasted AS (SELECT w.sku_id,max(w.label) AS label,max(w.unit) AS unit,count(*)::int AS entries,sum(w.quantity) AS quantity,sum(w.kg) AS kg,sum(w.value) AS value
        FROM weight_wastage_entries w JOIN businesses b ON b.id=w.business_id WHERE ${IN_PERIOD('w')} GROUP BY w.sku_id),
      sold AS (SELECT dl.sku_id,sum(dl.quantity - COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=dl.business_id AND rl.line_id=dl.id),0)) AS quantity
        FROM business_document_lines dl JOIN business_documents d ON d.business_id=dl.business_id AND d.id=dl.document_id JOIN businesses b ON b.id=d.business_id
        WHERE ${IN_PERIOD('d')} AND d.kind='sale' AND dl.sku_id IN (SELECT sku_id FROM wasted) GROUP BY dl.sku_id)
      SELECT wasted.*,COALESCE(sold.quantity,0) AS sold_quantity,
        round(100*wasted.quantity/NULLIF(wasted.quantity+COALESCE(sold.quantity,0),0),2) AS wastage_percent
      FROM wasted LEFT JOIN sold ON sold.sku_id=wasted.sku_id ORDER BY wasted.value DESC`, values),
    repo.all(repo.pool, `SELECT w.reason,count(*)::int AS entries,sum(w.kg) AS kg,sum(w.value) AS value FROM weight_wastage_entries w JOIN businesses b ON b.id=w.business_id
      WHERE ${IN_PERIOD('w')} GROUP BY w.reason ORDER BY sum(w.value) DESC`, values),
    repo.all(repo.pool, `SELECT (w.created_at AT TIME ZONE b.timezone)::date::text AS day,count(*)::int AS entries,sum(w.kg) AS kg,sum(w.value) AS value
      FROM weight_wastage_entries w JOIN businesses b ON b.id=w.business_id WHERE ${IN_PERIOD('w')} GROUP BY 1 ORDER BY 1 DESC`, values),
  ]);
  return {
    from, to, items, reasons: reasons.map((r) => ({ ...r, label: REASONS[r.reason] })), days,
    totals: { entries: items.reduce((s, r) => s + r.entries, 0), kg: qty(items.reduce((s, r) => s + milli(r.kg || 0), 0)), value: rupees(items.reduce((s, r) => s + paise(r.value), 0)) },
  };
}

// Today's figures for the wastage screen's tiles.
async function wastageToday(business) {
  requireModule(business, 'wastage', 'Daily wastage');
  await access.require(business, 'wastage.view');
  // count(w.id), not count(*): a day with no entries still has the business row.
  return repo.one(repo.pool, `SELECT count(w.id)::int AS entries,COALESCE(sum(w.kg),0) AS kg,COALESCE(sum(w.value),0) AS value,
    (SELECT COALESCE(sum(value),0) FROM weight_wastage_entries x WHERE x.business_id=$1 AND date_trunc('month', x.created_at AT TIME ZONE b.timezone) = date_trunc('month', now() AT TIME ZONE b.timezone)) AS month_value,
    (SELECT COALESCE(sum(kg),0) FROM weight_wastage_entries x WHERE x.business_id=$1 AND date_trunc('month', x.created_at AT TIME ZONE b.timezone) = date_trunc('month', now() AT TIME ZONE b.timezone)) AS month_kg
    FROM businesses b LEFT JOIN weight_wastage_entries w ON w.business_id=b.id AND (w.created_at AT TIME ZONE b.timezone)::date = (now() AT TIME ZONE b.timezone)::date
    WHERE b.id=$1 GROUP BY b.id,b.timezone`, [business.id]);
}

module.exports = {
  createTemplate, updateTemplate, processBatch, batchDetail, recordWastage, yieldReport, wastageReport, wastageToday, REASONS,
  // Used by businessWeightDaily.service.js.
  wasteFromLot, SKU_SQL, kgFactor, readQuantity, requireModule, hashOf, derivedKey,
};
