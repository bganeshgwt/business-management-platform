const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const returns = require('../../core/services/businessReturns.service');
const counterPins = require('../../core/services/businessCounter.service');
const h = require('./healthCommon');

// Pharmacy (round 2, R2-HEALTH). Standard Indian practice, see
// docs/DECISIONS_ROUND2.md › Pharmacy & clinic:
//
//   Drug master     salt / composition, strength, form, maker, schedule (none,
//                   G, H, H1, X, narcotic), pack (strips × tablets), storage and
//                   cold chain, on top of the shared catalogue item. Substitutes
//                   are the items with the same salt and strength.
//   Prescription    a sale with a Schedule H / H1 / X / narcotic medicine goes
//   sale            through /pharmacy/sales: the doctor's name and registration
//                   number and a scan are recorded with the bill, batches are
//                   taken first-to-expire (never a recalled one), H1 and X lines
//                   are written to their registers in the same transaction, and
//                   Schedule X / narcotics need the registered pharmacist's PIN.
//                   The database refuses such a medicine on a plain bill.
//   Batches         near-expiry by distributor, debit notes (expiry / breakage
//                   returns posted as supplier returns), recalls that find every
//                   sale of the batch and block it.

const { fail, id, optionalId, text } = h;
const SCHEDULED = ['H', 'H1', 'X', 'narcotic'];
const SIGNED = ['X', 'narcotic'];
const FORMS = ['tablet', 'capsule', 'syrup', 'suspension', 'injection', 'ointment', 'cream', 'drops', 'inhaler', 'powder', 'gel', 'solution', 'device', 'other'];
const SCHEDULES = ['none', 'G', 'H', 'H1', 'X', 'narcotic'];
const milli = (n) => Math.round(Number(n) * 1000);
const q3 = (m) => (m / 1000).toFixed(3).replace(/\.?0+$/, '');
const requirePharmacy = (business) => {
  h.requireType(business, ['pharmacy'], 'Pharmacy screens');
  if (!business.modules.includes('pharmacy')) fail('Pharmacy rules are not switched on for this business. An owner can turn them on in Settings › Business tools.', 403);
};
// A deterministic request key (UUID v4 shape) for a posting made on behalf of another.
const derivedKey = (...parts) => {
  const hex = crypto.createHash('sha256').update(parts.join('|')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

repo.addLists({
  // The drug master: every goods item with its drug details (or none yet) and stock.
  'pharmacy-drugs': {
    sql: `SELECT s.id,s.code,s.label,s.unit,s.price,s.mrp,s.tax_rate,s.hsn_code,s.active,s.tracking,p.name AS product_name,p.brand,
      d.composition,d.composition_key,d.strength,d.form,d.manufacturer,COALESCE(d.schedule,'unset') AS schedule,d.units_per_strip,d.strips_per_box,
      COALESCE(d.loose_sale,false) AS loose_sale,COALESCE(d.cold_chain,false) AS cold_chain,d.storage,(d.sku_id IS NOT NULL) AS has_master,
      COALESCE((SELECT sum(l.quantity) FROM business_stock_lots l WHERE l.business_id=s.business_id AND l.sku_id=s.id),0) AS stock,
      (SELECT count(*)::int FROM pharmacy_drugs x WHERE d.sku_id IS NOT NULL AND x.business_id=d.business_id AND x.composition_key=d.composition_key
        AND lower(COALESCE(x.strength,''))=lower(COALESCE(d.strength,'')) AND x.sku_id<>d.sku_id) AS substitutes
      FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id AND p.kind='goods'
      LEFT JOIN pharmacy_drugs d ON d.business_id=s.business_id AND d.sku_id=s.id WHERE s.business_id=$1`,
    search: ['label', 'code', 'composition', 'manufacturer', 'brand', 'product_name'],
    filters: { schedule: 'schedule', cold_chain: 'cold_chain', has_master: 'has_master', active: 'active' }, order: 'label,id',
  },
  'pharmacy-prescriptions': {
    sql: `SELECT r.id,r.document_id,d.document_no,d.total,d.location_id,r.patient_name,r.patient_phone,r.patient_age,r.doctor_name,r.doctor_reg_no,r.prescribed_on,r.retain_until,
      r.file_id,r.created_at,u.name AS created_by_name,g.name AS pharmacist_name,
      (SELECT string_agg(DISTINCT pd.schedule,',') FROM business_document_lines l JOIN pharmacy_drugs pd ON pd.business_id=l.business_id AND pd.sku_id=l.sku_id
        WHERE l.business_id=r.business_id AND l.document_id=r.document_id AND pd.schedule IN ('H','H1','X','narcotic')) AS schedules,
      (SELECT string_agg(l.label,', ' ORDER BY l.id) FROM business_document_lines l WHERE l.business_id=r.business_id AND l.document_id=r.document_id) AS items
      FROM pharmacy_prescriptions r JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id
      JOIN users u ON u.id=r.created_by LEFT JOIN health_signatories g ON g.business_id=r.business_id AND g.id=r.signatory_id WHERE r.business_id=$1`,
    search: ['patient_name', 'patient_phone', 'doctor_name', 'doctor_reg_no', 'document_no', 'items'], date: 'created_at', filters: { location: 'location_id' }, order: 'created_at DESC,id DESC',
  },
  'pharmacy-register': {
    // `returned`: what of the entry's line came back later (the entry itself is never changed).
    sql: `SELECT e.*,d.document_no,d.location_id,g.name AS pharmacist_name,g.registration_no AS pharmacist_reg_no,u.name AS created_by_name,
      COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=e.business_id AND rl.line_id=e.line_id),0) AS returned
      FROM pharmacy_register_entries e JOIN business_documents d ON d.business_id=e.business_id AND d.id=e.document_id
      JOIN users u ON u.id=e.created_by LEFT JOIN health_signatories g ON g.business_id=e.business_id AND g.id=e.signatory_id WHERE e.business_id=$1`,
    search: ['drug_name', 'composition', 'patient_name', 'doctor_name', 'doctor_reg_no', 'lot_code', 'document_no'], date: 'created_at',
    filters: { register: 'register', location: 'location_id' }, order: 'created_at DESC,id DESC',
  },
  'pharmacy-recalls': {
    sql: `SELECT r.*,s.label,s.code,u.name AS created_by_name,
      (SELECT count(DISTINCT l.document_id)::int FROM business_document_lines l JOIN business_documents d ON d.business_id=l.business_id AND d.id=l.document_id AND d.kind='sale'
        WHERE l.business_id=r.business_id AND l.sku_id=r.sku_id AND l.lot_code=r.lot_code) AS sales,
      COALESCE((SELECT sum(x.quantity) FROM business_stock_lots x WHERE x.business_id=r.business_id AND x.sku_id=r.sku_id AND x.lot_code=r.lot_code),0) AS on_hand
      FROM pharmacy_recalls r JOIN catalog_skus s ON s.business_id=r.business_id AND s.id=r.sku_id JOIN users u ON u.id=r.created_by WHERE r.business_id=$1`,
    search: ['label', 'code', 'lot_code', 'reason', 'reference'], date: 'created_at', filters: { status: 'status' }, order: "status='open' DESC,created_at DESC,id DESC",
  },
  'pharmacy-debit-notes': {
    sql: `SELECT n.*,c.name AS supplier_name,l.name AS location_name,u.name AS created_by_name,
      (SELECT count(*)::int FROM pharmacy_debit_note_lines x WHERE x.business_id=n.business_id AND x.debit_note_id=n.id) AS line_count,
      (n.status='credited' AND n.credited_amount < n.claimed) AS short_credited
      FROM pharmacy_debit_notes n JOIN business_contacts c ON c.business_id=n.business_id AND c.id=n.contact_id
      JOIN business_locations l ON l.business_id=n.business_id AND l.id=n.location_id JOIN users u ON u.id=n.created_by WHERE n.business_id=$1`,
    search: ['note_no', 'supplier_name', 'credit_note_no', 'notes'], date: 'created_at', filters: { status: 'status', supplier: 'contact_id', reason: 'reason', location: 'location_id' },
    order: 'created_at DESC,id DESC',
  },
});

// --- Drug master -----------------------------------------------------------------------------

function drugFields(body) {
  const schedule = v.requiredEnum(body.schedule ?? 'none', 'Schedule', SCHEDULES);
  const optionalCount = (value, name) => (value === undefined || value === null || value === '' ? null
    : Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 1000 ? Number(value) : fail(`${name} must be a whole number from 1 to 1000`));
  const unitsPerStrip = optionalCount(body.unitsPerStrip, 'Tablets per strip');
  const looseSale = v.requiredBoolean(body.looseSale, 'Sold loose', false);
  if (looseSale && !unitsPerStrip) fail('Give the number of tablets in a strip to sell it loose');
  return {
    composition: v.requiredString(body.composition, 'Composition (salt)', 300), strength: text(body.strength, 'Strength', 60),
    form: v.requiredEnum(body.form ?? 'tablet', 'Form', FORMS), manufacturer: text(body.manufacturer, 'Manufacturer', 150), schedule,
    unitsPerStrip, stripsPerBox: optionalCount(body.stripsPerBox, 'Strips per box'), looseSale,
    coldChain: v.requiredBoolean(body.coldChain, 'Cold chain', false), storage: text(body.storage, 'Storage', 150),
  };
}

// Pack sizes follow the pack: an item stocked in tablets gets "1 strip = N
// tablets" (and a box); an item stocked in strips gets "1 box = N strips".
async function ensurePack(db, business, user, sku, unitCode, quantity) {
  if (!quantity || unitCode === sku.unit) return;
  const unit = await repo.one(db, 'SELECT code FROM business_units WHERE business_id=$1 AND code=$2 AND active', [business.id, unitCode]);
  if (!unit) return;
  const existing = await repo.one(db, 'SELECT * FROM catalog_sku_units WHERE business_id=$1 AND sku_id=$2 AND unit_code=$3', [business.id, sku.id, unitCode]);
  if (!existing) {
    await db.query('INSERT INTO catalog_sku_units(business_id,sku_id,unit_code,quantity_in_base,created_by) VALUES($1,$2,$3,$4,$5)', [business.id, sku.id, unitCode, quantity, user.id]);
  } else if (Number(existing.quantity_in_base) !== Number(quantity) || !existing.active) {
    await db.query('UPDATE catalog_sku_units SET quantity_in_base=$3,active=true WHERE business_id=$1 AND id=$2', [business.id, existing.id, quantity]);
  }
}

async function saveDrug(business, user, skuId, body) {
  requirePharmacy(business);
  await access.require(business, 'pharmacy.edit');
  const f = drugFields(body);
  return repo.transaction(async (db) => {
    const sku = await repo.one(db, `SELECT s.* FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id AND p.kind='goods'
      WHERE s.business_id=$1 AND s.id=$2 FOR UPDATE OF s`, [business.id, id(skuId, 'Item')]);
    if (!sku) fail('Item not found', 404);
    const before = await repo.one(db, 'SELECT * FROM pharmacy_drugs WHERE business_id=$1 AND sku_id=$2', [business.id, sku.id]);
    const loose = ['tablet', 'capsule'].includes(sku.unit) || !['strip', 'bottle', 'each'].includes(sku.unit);
    if (f.looseSale && !loose) fail(`${sku.label} is stocked in ${sku.unit}s, so it cannot be sold by the tablet. Stock it in tablets to sell loose.`);
    const row = await repo.one(db, `INSERT INTO pharmacy_drugs(business_id,sku_id,composition,strength,form,manufacturer,schedule,units_per_strip,strips_per_box,loose_sale,cold_chain,storage,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (business_id,sku_id) DO UPDATE SET composition=EXCLUDED.composition,strength=EXCLUDED.strength,form=EXCLUDED.form,manufacturer=EXCLUDED.manufacturer,
        schedule=EXCLUDED.schedule,units_per_strip=EXCLUDED.units_per_strip,strips_per_box=EXCLUDED.strips_per_box,loose_sale=EXCLUDED.loose_sale,
        cold_chain=EXCLUDED.cold_chain,storage=EXCLUDED.storage,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
    [business.id, sku.id, f.composition, f.strength, f.form, f.manufacturer, f.schedule, f.unitsPerStrip, f.stripsPerBox, f.looseSale, f.coldChain, f.storage, user.id]);
    if (['tablet', 'capsule'].includes(sku.unit)) {
      await ensurePack(db, business, user, sku, 'strip', f.unitsPerStrip);
      if (f.unitsPerStrip && f.stripsPerBox) await ensurePack(db, business, user, sku, 'box', f.unitsPerStrip * f.stripsPerBox);
    } else if (sku.unit === 'strip' && f.stripsPerBox) {
      await ensurePack(db, business, user, sku, 'box', f.stripsPerBox);
    }
    await repo.audit(db, business.id, user.id, before ? 'pharmacy.drug_updated' : 'pharmacy.drug_created', sku.id, {
      label: sku.label, schedule: f.schedule, ...(before && before.schedule !== f.schedule ? { scheduleFrom: before.schedule } : {}),
    });
    return row;
  });
}

const drugSql = `SELECT s.id,s.code,s.label,s.unit,s.price,s.mrp,s.tax_rate,s.active,d.*,
  COALESCE((SELECT sum(l.quantity) FROM business_stock_lots l WHERE l.business_id=s.business_id AND l.sku_id=s.id
    AND l.quantity>0 AND (l.expires_on IS NULL OR l.expires_on>=(now() AT TIME ZONE b.timezone)::date)),0) AS usable_stock
  FROM catalog_skus s JOIN businesses b ON b.id=s.business_id LEFT JOIN pharmacy_drugs d ON d.business_id=s.business_id AND d.sku_id=s.id`;

// One drug with its pack sizes, usable batches (first to expire first) and substitutes.
async function drug(business, skuId) {
  requirePharmacy(business);
  await access.requireAny(business, ['pharmacy.view', 'sales.create']);
  const row = await repo.one(repo.pool, `${drugSql} WHERE s.business_id=$1 AND s.id=$2`, [business.id, id(skuId, 'Item')]);
  if (!row) fail('Item not found', 404);
  row.id = row.id || Number(skuId);
  const [packs, lots, substitutes] = await Promise.all([
    repo.all(repo.pool, 'SELECT unit_code,quantity_in_base FROM catalog_sku_units WHERE business_id=$1 AND sku_id=$2 AND active ORDER BY quantity_in_base', [business.id, row.id]),
    usableLots(repo.pool, business, row.id, null),
    substitutesOf(business, row),
  ]);
  return { ...row, sku_id: row.id, packs, lots, substitutes };
}
async function substitutesOf(business, row) {
  if (!row.composition_key) return [];
  return repo.all(repo.pool, `SELECT * FROM (${drugSql} WHERE s.business_id=$1 AND s.active AND d.composition_key=$2 AND lower(COALESCE(d.strength,''))=lower(COALESCE($3::text,'')) AND s.id<>$4) x
    ORDER BY x.usable_stock=0, x.price, x.label LIMIT 20`, [business.id, row.composition_key, row.strength, row.id]);
}
async function substitutes(business, skuId) {
  const found = await drug(business, skuId);
  return found.substitutes;
}

// Batches that may be sold today: in stock, not expired, not recalled and
// blocked; first to expire first.
function usableLots(db, business, skuId, locationId, lock = false) {
  return repo.all(db, `SELECT l.* FROM business_stock_lots l
    WHERE l.business_id=$1 AND l.sku_id=$2 AND ($3::bigint IS NULL OR l.location_id=$3) AND l.quantity>0
      AND (l.expires_on IS NULL OR l.expires_on>=(now() AT TIME ZONE $4)::date)
      AND NOT EXISTS (SELECT 1 FROM pharmacy_recalls r WHERE r.business_id=l.business_id AND r.sku_id=l.sku_id AND r.lot_code=l.lot_code AND r.status='open' AND r.blocked)
    ORDER BY l.expires_on NULLS LAST, l.id ${lock ? 'FOR UPDATE' : ''}`, [business.id, skuId, locationId, business.timezone]);
}

// --- The prescription sale -----------------------------------------------------------------

function readPrescription(body, todayDay) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const prescribedOn = h.dateOnly(body.prescribedOn, 'Prescription date');
  if (prescribedOn > todayDay) fail('The prescription date cannot be in the future');
  const age = body.patientAge === undefined || body.patientAge === null || body.patientAge === '' ? null : Number(body.patientAge);
  if (age !== null && (!Number.isInteger(age) || age < 0 || age > 130)) fail('Patient age must be a whole number of years');
  return {
    patientName: v.requiredString(body.patientName, 'Patient name', 150), patientPhone: text(body.patientPhone, 'Patient phone', 30), patientAge: age,
    patientAddress: text(body.patientAddress, 'Patient address', 300),
    doctorName: v.requiredString(body.doctorName, 'Doctor\'s name', 150), doctorRegNo: v.requiredString(body.doctorRegNo, 'Doctor\'s registration number', 60),
    doctorAddress: text(body.doctorAddress, 'Doctor\'s clinic / address', 300), prescribedOn, fileId: optionalId(body.fileId, 'Prescription scan'),
  };
}
// One payment or several (split payment, as on Quick bill: up to 8 parts,
// one may be "the rest", change from cash only). A walk-in pays in full.
const readPayment = (business, body) => core.readPayments(body);

// Splits each requested quantity over the usable batches, first to expire
// first: whole strips from each batch while it has them, then (for a drug that
// may be cut) loose tablets.
async function allocate(db, business, locationId, inputs) {
  const lines = [];
  const remaining = new Map();
  for (const [index, input] of inputs.entries()) {
    const n = index + 1;
    const sku = await repo.one(db, `SELECT s.*,u.name AS unit_name FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id AND p.kind='goods' AND p.active
      JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit WHERE s.business_id=$1 AND s.id=$2 AND s.active`, [business.id, id(input?.skuId, `Item on line ${n}`)]);
    if (!sku) fail(`Item on line ${n} not found`, 404);
    const drugRow = await repo.one(db, 'SELECT * FROM pharmacy_drugs WHERE business_id=$1 AND sku_id=$2', [business.id, sku.id]);
    const unit = input.unit && input.unit !== sku.unit ? String(input.unit) : sku.unit;
    let factor = 1;
    if (unit !== sku.unit) {
      const pack = await repo.one(db, 'SELECT quantity_in_base FROM catalog_sku_units WHERE business_id=$1 AND sku_id=$2 AND unit_code=$3 AND active', [business.id, sku.id, unit]);
      if (!pack) fail(`${sku.label} has no pack size in ${unit}. Add it in the drug master (tablets per strip).`);
      factor = Number(pack.quantity_in_base);
    }
    const quantity = core.decimal(input.quantity, `Quantity of ${sku.label}`, 3, 0.001, 100000);
    if (!Number.isInteger(quantity) && sku.tracking !== 'none') fail(`${sku.label} is sold in whole ${unit}s`);
    const strip = drugRow?.units_per_strip && ['tablet', 'capsule'].includes(sku.unit) ? Number(drugRow.units_per_strip) : null;
    if (unit === sku.unit && strip && !drugRow.loose_sale && quantity % strip !== 0) {
      fail(`${sku.label} is sold by the strip of ${strip}, not loose. Sell ${Math.ceil(quantity / strip)} strip(s), or allow loose sale in the drug master.`);
    }
    const looseOk = !strip || drugRow.loose_sale;
    if (sku.tracking !== 'batch') {
      lines.push({ sku, drug: drugRow, core: { skuId: sku.id, quantity: String(quantity), ...(unit !== sku.unit ? { unit } : {}) }, stockMilli: milli(quantity * factor), lot: null });
      continue;
    }
    let lots = await usableLots(db, business, sku.id, locationId, true);
    if (input.lotCode) {
      const wanted = String(input.lotCode);
      if (!lots.some((l) => l.lot_code === wanted)) {
        const recalled = await repo.one(db, "SELECT 1 FROM pharmacy_recalls WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3 AND status='open' AND blocked", [business.id, sku.id, wanted]);
        fail(recalled ? `Batch ${wanted} of ${sku.label} is recalled and blocked` : `Batch ${wanted} of ${sku.label} is not usable stock here`, 409);
      }
      lots = lots.filter((l) => l.lot_code === wanted);
    }
    for (const lot of lots) if (!remaining.has(lot.id)) remaining.set(lot.id, milli(lot.quantity));
    let wantStock = milli(quantity * factor);
    const factorMilli = milli(factor);
    // Whole packs first.
    if (factor > 1) {
      let packs = quantity;
      for (const lot of lots) {
        if (packs <= 0) break;
        const take = Math.min(packs, Math.floor(remaining.get(lot.id) / factorMilli));
        if (take <= 0) continue;
        lines.push({ sku, drug: drugRow, lot, core: { skuId: sku.id, quantity: String(take), unit, lotCode: lot.lot_code }, stockMilli: take * factorMilli });
        remaining.set(lot.id, remaining.get(lot.id) - take * factorMilli);
        packs -= take; wantStock -= take * factorMilli;
      }
      if (wantStock > 0 && !looseOk) fail(`Only ${quantity - packs} whole ${unit}(s) of ${sku.label} are in usable stock; it is not sold loose`, 409);
    }
    for (const lot of lots) {
      if (wantStock <= 0) break;
      const take = Math.min(wantStock, remaining.get(lot.id));
      if (take <= 0) continue;
      lines.push({ sku, drug: drugRow, lot, core: { skuId: sku.id, quantity: q3(take), lotCode: lot.lot_code }, stockMilli: take });
      remaining.set(lot.id, remaining.get(lot.id) - take);
      wantStock -= take;
    }
    if (wantStock > 0) fail(`Not enough usable stock of ${sku.label}: ${q3(milli(quantity * factor) - wantStock)} ${sku.unit} left that is not expired or recalled`, 409);
  }
  return lines;
}

// POST /pharmacy/sales — see the top of this file.
async function sell(business, user, body) {
  requirePharmacy(business);
  await access.require(business, 'sales.create');
  const key = h.requestKey(body.requestKey);
  // The biller's counter PIN is checked, never stored, not even in the hash.
  const { counterPin, ...hashed } = body;
  const hash = h.hashOf(hashed);
  const inputs = v.requiredArray(body.lines, 'Lines');
  if (!inputs.length || inputs.length > 60) fail('Add between 1 and 60 lines');
  const paidNow = readPayment(business, body);
  if (paidNow.length) await access.require(business, 'sales.edit');
  // A shared till that asks the biller's PIN for every bill (round 2): the
  // pharmacy counter is a counter bill, like Quick bill.
  if (body.channel === 'counter') await counterPins.checkBill(business, user, counterPin);
  const settings = await h.settings(repo.pool, business.id);
  const todayDay = await h.today(repo.pool, business);
  // What the bill holds decides what is needed (read again inside the transaction).
  const skuIds = inputs.map((l) => id(l?.skuId, 'Item'));
  const schedules = (await repo.all(repo.pool, 'SELECT sku_id,schedule FROM pharmacy_drugs WHERE business_id=$1 AND sku_id=ANY($2::bigint[])', [business.id, skuIds]))
    .map((r) => r.schedule);
  const needsRx = schedules.some((s) => SCHEDULED.includes(s));
  const needsSign = schedules.some((s) => SIGNED.includes(s));
  const prescription = readPrescription(body.prescription, todayDay);
  if (needsRx) {
    await access.require(business, 'pharmacy.create');
    if (!prescription) fail('This bill has a prescription medicine (Schedule H, H1 or X). Enter the prescription: patient, doctor, registration number and date.', 409, { reason: 'prescription_required' });
    if (settings.rx_scan_required && !prescription.fileId) fail('Attach a photo or scan of the prescription (Pharmacy settings require it).', 409, { reason: 'prescription_scan_required' });
  }
  // The registered pharmacist signs for Schedule X and narcotics with their PIN (checked before any lock).
  const signer = needsSign ? await h.verifySignature(business, 'pharmacist', body.signoff, 'A Schedule X medicine')
    : body.signoff ? await h.verifySignature(business, 'pharmacist', body.signoff, 'The sign-off') : null;
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND request_key=$2', [business.id, key]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return { document: old, prescription: await repo.one(db, 'SELECT * FROM pharmacy_prescriptions WHERE business_id=$1 AND document_id=$2', [business.id, old.id]), repeated: true };
    }
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.locationId, 'Location')]);
    if (!location) fail('Location not found', 404);
    if (prescription?.fileId) {
      const file = await repo.one(db, `SELECT f.id FROM health_files f WHERE f.business_id=$1 AND f.id=$2 AND f.kind='prescription'
        AND NOT EXISTS (SELECT 1 FROM pharmacy_prescriptions r WHERE r.business_id=f.business_id AND r.file_id=f.id)`, [business.id, prescription.fileId]);
      if (!file) fail('That prescription scan is not available (it may be on another bill already)', 409);
    }
    const lines = await allocate(db, business, location.id, inputs);
    const scheduledLines = lines.filter((l) => SCHEDULED.includes(l.drug?.schedule));
    const document = await core.postDocument(db, business, user, { ...hashed, kind: 'sale', locationId: location.id, lines: lines.map((l) => l.core) },
      { kind: 'sale', requestKey: key, hash, lines: lines.map((l) => l.core), paidNow, walkInPays: true });
    let saved = null;
    const registers = [];
    if (prescription && (scheduledLines.length || needsRx)) {
      const retain = Math.max(Number(settings.prescription_retention_years), scheduledLines.some((l) => SIGNED.includes(l.drug.schedule)) ? Number(settings.x_retention_years) : 0,
        scheduledLines.some((l) => l.drug.schedule === 'H1') ? Number(settings.h1_retention_years) : 0);
      saved = await repo.one(db, `INSERT INTO pharmacy_prescriptions(business_id,document_id,contact_id,patient_name,patient_phone,patient_age,patient_address,doctor_name,doctor_reg_no,
        doctor_address,prescribed_on,file_id,signatory_id,retain_until,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,($14::date + make_interval(years => $15::int))::date,$16) RETURNING *`,
      [business.id, document.id, document.contact_id, prescription.patientName, prescription.patientPhone, prescription.patientAge, prescription.patientAddress,
        prescription.doctorName, prescription.doctorRegNo, prescription.doctorAddress, prescription.prescribedOn, prescription.fileId, signer?.id || null, todayDay, retain, user.id]);
      const posted = await repo.all(db, 'SELECT id,sku_id,label,unit,quantity,lot_code FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, document.id]);
      for (const [index, line] of lines.entries()) {
        const schedule = line.drug?.schedule;
        if (!['H1', 'X', 'narcotic'].includes(schedule)) continue;
        const postedLine = posted[index];
        const years = schedule === 'H1' ? settings.h1_retention_years : settings.x_retention_years;
        const entry = await repo.one(db, `INSERT INTO pharmacy_register_entries(business_id,register,prescription_id,document_id,line_id,sku_id,drug_name,composition,quantity,unit,lot_code,
          expires_on,patient_name,patient_address,doctor_name,doctor_reg_no,doctor_address,signatory_id,retain_until,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,($19::date + make_interval(years => $20::int))::date,$21) RETURNING *`,
        [business.id, schedule, saved.id, document.id, postedLine.id, line.sku.id, postedLine.label, line.drug.composition, postedLine.quantity, postedLine.unit, postedLine.lot_code || '',
          line.lot?.expires_on || null, prescription.patientName, prescription.patientAddress, prescription.doctorName, prescription.doctorRegNo, prescription.doctorAddress,
          SIGNED.includes(schedule) ? signer.id : signer?.id || null, todayDay, Number(years), user.id]);
        registers.push(entry);
      }
      await repo.audit(db, business.id, user.id, 'pharmacy.dispensed', saved.id, {
        documentNo: document.document_no, patient: prescription.patientName, doctor: prescription.doctorName, doctorRegNo: prescription.doctorRegNo,
        schedules: [...new Set(scheduledLines.map((l) => l.drug.schedule))], registerEntries: registers.length, pharmacist: signer?.name || null,
      });
      await repo.event(db, business.id, user.id, 'pharmacy.dispensed', 'prescription', saved.id, { documentId: document.id, documentNo: document.document_no, registerEntries: registers.length });
    }
    return { document, prescription: saved, registers };
  });
}

async function prescription(business, user, prescriptionId) {
  requirePharmacy(business);
  await access.require(business, 'pharmacy.view');
  const row = await repo.one(repo.pool, `SELECT r.*,d.document_no,d.total,d.created_at AS billed_at,f.file_name,f.mime_type,g.name AS pharmacist_name,g.registration_no AS pharmacist_reg_no
    FROM pharmacy_prescriptions r JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id
    LEFT JOIN health_files f ON f.business_id=r.business_id AND f.id=r.file_id
    LEFT JOIN health_signatories g ON g.business_id=r.business_id AND g.id=r.signatory_id WHERE r.business_id=$1 AND r.id=$2`, [business.id, id(prescriptionId, 'Prescription')]);
  if (!row) fail('Prescription not found', 404);
  const lines = await repo.all(repo.pool, `SELECT l.id,l.label,l.quantity,l.unit,l.lot_code,l.entered_unit,l.entered_quantity,pd.schedule,pd.composition FROM business_document_lines l
    LEFT JOIN pharmacy_drugs pd ON pd.business_id=l.business_id AND pd.sku_id=l.sku_id WHERE l.business_id=$1 AND l.document_id=$2 ORDER BY l.id`, [business.id, row.document_id]);
  return { ...row, lines };
}

// What a pharmacy bill prints besides the core invoice: licences, the
// pharmacist, the prescription and each line's schedule and expiry.
async function invoiceExtras(db, business, documentId) {
  if (business.business_type !== 'pharmacy') return null;
  const [settings, branch, rx, lines, pharmacists] = await Promise.all([
    h.settings(db, business.id),
    // The selling branch's own licences, when it has them.
    repo.one(db, `SELECT p.* FROM pharmacy_location_licences p JOIN business_documents d ON d.business_id=p.business_id AND d.location_id=p.location_id
      WHERE d.business_id=$1 AND d.id=$2`, [business.id, documentId]),
    repo.one(db, `SELECT r.patient_name,r.doctor_name,r.doctor_reg_no,r.prescribed_on,g.name AS pharmacist_name,g.registration_no AS pharmacist_reg_no
      FROM pharmacy_prescriptions r LEFT JOIN health_signatories g ON g.business_id=r.business_id AND g.id=r.signatory_id WHERE r.business_id=$1 AND r.document_id=$2`, [business.id, documentId]),
    repo.all(db, `SELECT l.id AS line_id,pd.schedule,lt.expires_on FROM business_document_lines l
      JOIN business_documents d ON d.business_id=l.business_id AND d.id=l.document_id
      LEFT JOIN pharmacy_drugs pd ON pd.business_id=l.business_id AND pd.sku_id=l.sku_id
      LEFT JOIN business_stock_lots lt ON lt.business_id=l.business_id AND lt.location_id=d.location_id AND lt.sku_id=l.sku_id AND lt.lot_code=l.lot_code AND l.lot_code<>''
      WHERE l.business_id=$1 AND l.document_id=$2 ORDER BY l.id`, [business.id, documentId]),
    repo.all(db, "SELECT name,registration_no FROM health_signatories WHERE business_id=$1 AND kind='pharmacist' AND active ORDER BY id LIMIT 1", [business.id]),
  ]);
  const held = branch || settings;
  const licences = [['20', held.drug_licence_20], ['21', held.drug_licence_21], ['20B', held.drug_licence_20b], ['21B', held.drug_licence_21b], ['20F', held.drug_licence_20f]]
    .filter(([, value]) => value).map(([form, number]) => ({ form, number }));
  const pharmacist = rx?.pharmacist_name ? { name: rx.pharmacist_name, registration_no: rx.pharmacist_reg_no } : pharmacists[0] || null;
  return { licences, pharmacist, prescription: rx || null, lines };
}

// --- Registers and reports --------------------------------------------------------------------

async function registerSummary(business, query) {
  requirePharmacy(business);
  await access.require(business, 'pharmacy.view');
  const from = core.dateText(query.from, 'From date'), to = core.dateText(query.to, 'To date');
  const row = await repo.one(repo.pool, `WITH p AS (SELECT * FROM pharmacy_prescriptions WHERE business_id=$1 AND (created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date),
    e AS (SELECT * FROM pharmacy_register_entries WHERE business_id=$1 AND (created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date)
    SELECT (SELECT count(*)::int FROM p) AS prescriptions,
      (SELECT count(*)::int FROM e WHERE register='H1') AS h1_entries,
      (SELECT count(*)::int FROM e WHERE register IN ('X','narcotic')) AS x_entries,
      (SELECT count(DISTINCT doctor_reg_no)::int FROM p) AS doctors,
      (SELECT count(*)::int FROM p WHERE file_id IS NULL) AS without_scan,
      (SELECT count(*)::int FROM pharmacy_debit_notes WHERE business_id=$1 AND status='sent') AS returns_awaiting_credit,
      (SELECT COALESCE(sum(claimed),0) FROM pharmacy_debit_notes WHERE business_id=$1 AND status='sent') AS returns_awaiting_value,
      (SELECT count(*)::int FROM pharmacy_recalls WHERE business_id=$1 AND status='open') AS open_recalls`, [business.id, from, to, business.timezone]);
  return { from, to, ...row };
}

// --- Recalls ------------------------------------------------------------------------------------

async function salesOfBatch(db, business, skuId, lotCode) {
  // One row per bill: what it took of the batch, and who to call.
  return repo.all(db, `SELECT d.id AS document_id,d.document_no,d.created_at,sum(l.quantity) AS quantity,min(l.unit) AS unit,d.contact_id,
      COALESCE(min(c.name),min(r.patient_name),min(d.contact_name)) AS customer_name,COALESCE(min(c.phone),min(r.patient_phone)) AS phone,min(r.doctor_name) AS doctor_name,
      COALESCE(sum((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=l.business_id AND rl.line_id=l.id)),0) AS returned
    FROM business_document_lines l JOIN business_documents d ON d.business_id=l.business_id AND d.id=l.document_id AND d.kind='sale'
    LEFT JOIN business_contacts c ON c.business_id=d.business_id AND c.id=d.contact_id
    LEFT JOIN pharmacy_prescriptions r ON r.business_id=d.business_id AND r.document_id=d.id
    WHERE l.business_id=$1 AND l.sku_id=$2 AND l.lot_code=$3 GROUP BY d.id ORDER BY d.created_at DESC`, [business.id, skuId, lotCode]);
}

async function createRecall(business, user, body) {
  requirePharmacy(business);
  await access.require(business, 'pharmacy.approve');
  const lotCode = v.requiredString(body.lotCode, 'Batch number', 100);
  const reason = v.requiredString(body.reason, 'Reason', 300);
  return repo.transaction(async (db) => {
    const sku = await repo.one(db, 'SELECT id,label FROM catalog_skus WHERE business_id=$1 AND id=$2', [business.id, id(body.skuId, 'Item')]);
    if (!sku) fail('Item not found', 404);
    const known = await repo.one(db, `SELECT (SELECT count(*)::int FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3) AS lots,
      (SELECT count(*)::int FROM business_document_lines WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3) AS lines`, [business.id, sku.id, lotCode]);
    if (!known.lots && !known.lines) fail(`Batch ${lotCode} of ${sku.label} was never received or sold here`, 404);
    if (await repo.one(db, "SELECT 1 FROM pharmacy_recalls WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3 AND status='open'", [business.id, sku.id, lotCode])) {
      fail(`Batch ${lotCode} of ${sku.label} is already under recall`, 409);
    }
    const row = await repo.one(db, `INSERT INTO pharmacy_recalls(business_id,sku_id,lot_code,reason,reference,blocked,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [business.id, sku.id, lotCode, reason, text(body.reference, 'Alert reference', 120), v.requiredBoolean(body.block, 'Block the batch', true), user.id]);
    const sales = await salesOfBatch(db, business, sku.id, lotCode);
    await repo.audit(db, business.id, user.id, 'pharmacy.recall_opened', row.id, { label: sku.label, lotCode, blocked: row.blocked, sales: sales.length, reason });
    await repo.event(db, business.id, user.id, 'pharmacy.recall_opened', 'recall', row.id, { skuId: sku.id, lotCode, blocked: row.blocked, customers: sales.filter((s) => s.phone).length });
    return { ...row, label: sku.label, sales };
  });
}
async function recall(business, recallId) {
  requirePharmacy(business);
  await access.require(business, 'pharmacy.view');
  const row = await repo.one(repo.pool, `SELECT r.*,s.label,s.code FROM pharmacy_recalls r JOIN catalog_skus s ON s.business_id=r.business_id AND s.id=r.sku_id
    WHERE r.business_id=$1 AND r.id=$2`, [business.id, id(recallId, 'Recall')]);
  if (!row) fail('Recall not found', 404);
  const [sales, stock] = await Promise.all([
    salesOfBatch(repo.pool, business, row.sku_id, row.lot_code),
    repo.all(repo.pool, `SELECT l.id,l.quantity,l.expires_on,loc.name AS location_name FROM business_stock_lots l JOIN business_locations loc ON loc.business_id=l.business_id AND loc.id=l.location_id
      WHERE l.business_id=$1 AND l.sku_id=$2 AND l.lot_code=$3`, [business.id, row.sku_id, row.lot_code]),
  ]);
  return { ...row, sales, stock };
}
async function updateRecall(business, user, recallId, body) {
  requirePharmacy(business);
  await access.require(business, 'pharmacy.approve');
  const action = v.requiredEnum(body.action, 'Action', ['block', 'unblock', 'close']);
  return repo.transaction(async (db) => {
    const row = await repo.one(db, "SELECT * FROM pharmacy_recalls WHERE business_id=$1 AND id=$2 AND status='open' FOR UPDATE", [business.id, id(recallId, 'Recall')]);
    if (!row) fail('Open recall not found', 404);
    const note = action === 'block' ? null : v.requiredString(body.note, action === 'close' ? 'Closing note' : 'Reason to unblock', 300);
    const saved = action === 'close'
      ? await repo.one(db, "UPDATE pharmacy_recalls SET status='closed',blocked=false,closed_by=$3,closed_at=now(),close_note=$4 WHERE business_id=$1 AND id=$2 RETURNING *", [business.id, row.id, user.id, note])
      : await repo.one(db, 'UPDATE pharmacy_recalls SET blocked=$3,close_note=COALESCE($4,close_note) WHERE business_id=$1 AND id=$2 RETURNING *', [business.id, row.id, action === 'block', note]);
    await repo.audit(db, business.id, user.id, `pharmacy.recall_${action === 'close' ? 'closed' : action === 'block' ? 'blocked' : 'unblocked'}`, row.id, { lotCode: row.lot_code, note });
    return saved;
  });
}

// --- Near expiry by distributor and debit notes --------------------------------------------

// The distributor of a batch: the supplier of the latest purchase that brought it.
const supplierOfLot = `(SELECT d.contact_id FROM business_document_lines dl JOIN business_documents d ON d.business_id=dl.business_id AND d.id=dl.document_id AND d.kind='purchase'
  WHERE dl.business_id=l.business_id AND dl.sku_id=l.sku_id AND dl.lot_code=l.lot_code AND d.location_id=l.location_id ORDER BY d.created_at DESC,d.id DESC LIMIT 1)`;

async function nearExpiry(business, query) {
  requirePharmacy(business);
  await access.require(business, 'inventory.view');
  const settings = await h.settings(repo.pool, business.id);
  const days = query.days === undefined || query.days === '' ? Number(settings.near_expiry_days) : Number(query.days);
  if (!Number.isInteger(days) || days < 1 || days > 365) fail('Show batches expiring within 1 to 365 days');
  const location = optionalId(query.location, 'Location');
  const rows = await repo.all(repo.pool, `WITH today AS (SELECT (now() AT TIME ZONE timezone)::date AS d FROM businesses WHERE id=$1)
    SELECT l.id,l.location_id,loc.name AS location_name,l.sku_id,s.label,s.code,s.unit,l.lot_code,l.expires_on,l.quantity,l.unit_cost,
      (l.expires_on - today.d) AS days_left,round(l.quantity*l.unit_cost,2) AS cost_value,${supplierOfLot} AS supplier_id,
      EXISTS (SELECT 1 FROM pharmacy_recalls r WHERE r.business_id=l.business_id AND r.sku_id=l.sku_id AND r.lot_code=l.lot_code AND r.status='open') AS recalled
    FROM business_stock_lots l CROSS JOIN today
    JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
    JOIN business_locations loc ON loc.business_id=l.business_id AND loc.id=l.location_id
    WHERE l.business_id=$1 AND l.quantity>0 AND l.expires_on IS NOT NULL AND l.expires_on <= today.d + $2::int AND ($3::bigint IS NULL OR l.location_id=$3)
    ORDER BY l.expires_on, s.label, l.id LIMIT 1000`, [business.id, days, location]);
  const suppliers = await repo.all(repo.pool, "SELECT id,name,phone FROM business_contacts WHERE business_id=$1 AND kind='supplier'", [business.id]);
  const groups = new Map();
  for (const row of rows) {
    const key = row.supplier_id ? String(row.supplier_id) : 'none';
    if (!groups.has(key)) {
      const s = suppliers.find((x) => String(x.id) === key);
      groups.set(key, { supplier_id: s?.id || null, supplier_name: s?.name || 'No purchase on record', phone: s?.phone || null, lots: [], cost_value: 0, expired: 0 });
    }
    const g = groups.get(key);
    g.lots.push(row);
    g.cost_value += Math.round(Number(row.cost_value) * 100);
    if (row.days_left < 0) g.expired += 1;
  }
  const list = [...groups.values()].map((g) => ({ ...g, cost_value: (g.cost_value / 100).toFixed(2) })).sort((a, b) => Number(b.cost_value) - Number(a.cost_value));
  return { days, groups: list, totals: { batches: rows.length, expired: rows.filter((r) => r.days_left < 0).length,
    costValue: (rows.reduce((s, r) => s + Math.round(Number(r.cost_value) * 100), 0) / 100).toFixed(2) } };
}

async function createDebitNote(business, user, body) {
  requirePharmacy(business);
  await access.require(business, 'pharmacy.approve');
  await access.require(business, 'purchasing.refund');
  const key = h.requestKey(body.requestKey);
  const hash = h.hashOf(body);
  const reason = v.requiredEnum(body.reason, 'Reason', ['expired', 'near_expiry', 'breakage', 'recall', 'other']);
  const inputs = v.requiredArray(body.lines, 'Batches');
  if (!inputs.length || inputs.length > 100) fail('Add between 1 and 100 batches');
  const notes = text(body.notes, 'Notes', 300);
  const words = { expired: 'Expired', near_expiry: 'Near expiry', breakage: 'Breakage', recall: 'Recalled batch', other: 'Return' };
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM pharmacy_debit_notes WHERE business_id=$1 AND request_key=$2', [business.id, key]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for a different debit note', 409);
      return debitNoteDetail(db, business, old.id);
    }
    const supplier = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='supplier'", [business.id, id(body.contactId, 'Distributor')]);
    if (!supplier) fail('Distributor not found', 404);
    const prepared = [];
    let locationId = null;
    for (const [index, input] of inputs.entries()) {
      const lot = await repo.one(db, `SELECT l.*,s.label,s.unit,s.tracking,u.decimals AS unit_decimals FROM business_stock_lots l JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
        JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit WHERE l.business_id=$1 AND l.id=$2`, [business.id, id(input?.lotId, `Batch on line ${index + 1}`)]);
      if (!lot) fail('Batch not found', 404);
      if (locationId && Number(lot.location_id) !== Number(locationId)) fail('One debit note covers batches of one location');
      locationId = lot.location_id;
      const quantity = core.decimal(input.quantity ?? lot.quantity, `Quantity of ${lot.label}`, 3, 0.001, 100000);
      if (milli(quantity) > milli(lot.quantity)) fail(`Only ${Number(lot.quantity)} ${lot.unit} of ${lot.label} (batch ${lot.lot_code}) is in stock`, 409);
      if (prepared.some((p) => p.lot.id === lot.id)) fail('A batch may appear only once');
      prepared.push({ lot, quantity });
    }
    // Supplier returns on this distributor's purchases of each batch, oldest left first.
    const byDocument = new Map();
    const writeOffs = [];
    for (const item of prepared) {
      let left = milli(item.quantity);
      const purchased = await repo.all(db, `SELECT dl.id,dl.document_id,dl.quantity,
          COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=dl.business_id AND rl.line_id=dl.id),0) AS returned
        FROM business_document_lines dl JOIN business_documents d ON d.business_id=dl.business_id AND d.id=dl.document_id AND d.kind='purchase'
        WHERE dl.business_id=$1 AND dl.sku_id=$2 AND dl.lot_code=$3 AND d.location_id=$4 AND d.contact_id=$5 AND dl.stock_unit_cost IS NOT NULL
        ORDER BY d.created_at DESC,d.id DESC`, [business.id, item.lot.sku_id, item.lot.lot_code, item.lot.location_id, supplier.id]);
      for (const line of purchased) {
        if (left <= 0) break;
        const open = milli(line.quantity) - milli(line.returned);
        const take = Math.min(open, left);
        if (take <= 0) continue;
        if (!byDocument.has(line.document_id)) byDocument.set(line.document_id, []);
        byDocument.get(line.document_id).push({ lineId: line.id, quantity: q3(take), item });
        left -= take;
      }
      if (left > 0) writeOffs.push({ item, quantity: left });
    }
    if (writeOffs.length) await access.require(business, 'inventory.edit');
    const noteNo = await h.nextNumber(db, business.id, 'debit_note');
    const note = await repo.one(db, `INSERT INTO pharmacy_debit_notes(business_id,note_no,contact_id,location_id,reason,claimed,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,0,$6,$7,$8,$9) RETURNING *`, [business.id, noteNo, supplier.id, locationId, reason, notes, key, hash, user.id]);
    let claimed = 0, writtenOff = 0;
    for (const [documentId, lines] of byDocument) {
      const doc = await returns.lockDocument(db, business, documentId, 'refund');
      const input = { reason: `${words[reason]}: debit note ${noteNo}`, requestKey: derivedKey(key, documentId), lines: lines.map((l) => ({ lineId: l.lineId, quantity: l.quantity })) };
      const saved = await returns.postReturn(db, business, user, doc, { ...input, hash: h.hashOf(input) });
      claimed += Math.round(Number(saved.total) * 100);
      // Each batch's share of the return, for the note's lines.
      for (const l of lines) {
        const share = await repo.one(db, 'SELECT net+tax AS value FROM business_return_lines WHERE business_id=$1 AND return_id=$2 AND line_id=$3', [business.id, saved.id, l.lineId]);
        await db.query(`INSERT INTO pharmacy_debit_note_lines(business_id,debit_note_id,lot_id,sku_id,label,lot_code,expires_on,quantity,unit,value,return_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [business.id, note.id, l.item.lot.id, l.item.lot.sku_id, l.item.lot.label, l.item.lot.lot_code, l.item.lot.expires_on,
          l.quantity, l.item.lot.unit, share.value, saved.id]);
      }
    }
    for (const w of writeOffs) {
      const lot = await returns.lockLot(db, business.id, w.item.lot.id);
      const quantity = -w.quantity / 1000;
      const adjustment = await returns.applyAdjustment(db, business, user, lot, quantity, `${words[reason]}: debit note ${noteNo} (no purchase from ${supplier.name} on record), written off`,
        derivedKey(key, 'writeoff', lot.id));
      const value = Math.round((w.quantity / 1000) * Number(lot.unit_cost) * 100);
      writtenOff += value;
      await db.query(`INSERT INTO pharmacy_debit_note_lines(business_id,debit_note_id,lot_id,sku_id,label,lot_code,expires_on,quantity,unit,value,adjustment_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [business.id, note.id, lot.id, lot.sku_id, lot.label, lot.lot_code, lot.expires_on, q3(w.quantity), lot.unit, (value / 100).toFixed(2), adjustment.id]);
      await repo.event(db, business.id, user.id, 'stock.adjusted', 'stock_adjustment', adjustment.id, { lotId: lot.id, skuId: lot.sku_id, locationId: lot.location_id, quantity, reason: 'Debit note write-off' });
    }
    await db.query('UPDATE pharmacy_debit_notes SET claimed=$3,written_off=$4 WHERE business_id=$1 AND id=$2', [business.id, note.id, (claimed / 100).toFixed(2), (writtenOff / 100).toFixed(2)]);
    await repo.audit(db, business.id, user.id, 'pharmacy.debit_note_sent', note.id, { noteNo, supplier: supplier.name, reason, claimed: (claimed / 100).toFixed(2), writtenOff: (writtenOff / 100).toFixed(2) });
    await repo.event(db, business.id, user.id, 'pharmacy.debit_note_sent', 'debit_note', note.id, { noteNo, contactId: supplier.id, claimed: (claimed / 100).toFixed(2) });
    return debitNoteDetail(db, business, note.id);
  });
}

async function debitNoteDetail(db, business, noteId) {
  const note = await repo.one(db, `SELECT n.*,c.name AS supplier_name,c.gstin AS supplier_gstin,c.address AS supplier_address,c.phone AS supplier_phone,l.name AS location_name,u.name AS created_by_name
    FROM pharmacy_debit_notes n JOIN business_contacts c ON c.business_id=n.business_id AND c.id=n.contact_id
    JOIN business_locations l ON l.business_id=n.business_id AND l.id=n.location_id JOIN users u ON u.id=n.created_by WHERE n.business_id=$1 AND n.id=$2`, [business.id, noteId]);
  if (!note) fail('Debit note not found', 404);
  const lines = await repo.all(db, `SELECT x.*,r.return_no FROM pharmacy_debit_note_lines x LEFT JOIN business_returns r ON r.business_id=x.business_id AND r.id=x.return_id
    WHERE x.business_id=$1 AND x.debit_note_id=$2 ORDER BY x.id`, [business.id, note.id]);
  return { ...note, lines };
}
async function debitNote(business, noteId) {
  requirePharmacy(business);
  await access.require(business, 'pharmacy.view');
  return debitNoteDetail(repo.pool, business, id(noteId, 'Debit note'));
}
async function creditDebitNote(business, user, noteId, body) {
  requirePharmacy(business);
  await access.require(business, 'pharmacy.approve');
  const creditNoteNo = v.requiredString(body.creditNoteNo, 'Distributor\'s credit note number', 60);
  const creditNoteDate = h.dateOnly(body.creditNoteDate, 'Credit note date');
  const amount = core.decimal(body.amount, 'Amount credited', 2, 0, 100000000);
  return repo.transaction(async (db) => {
    const note = await repo.one(db, "SELECT * FROM pharmacy_debit_notes WHERE business_id=$1 AND id=$2 AND status='sent' FOR UPDATE", [business.id, id(noteId, 'Debit note')]);
    if (!note) fail('This debit note is not waiting for a credit note', 409);
    if (creditNoteDate > await h.today(db, business)) fail('The credit note date cannot be in the future');
    if (Math.round(amount * 100) > Math.round(Number(note.claimed) * 100)) fail(`The credit is more than the ${Number(note.claimed).toFixed(2)} claimed on this note`, 409);
    await db.query(`UPDATE pharmacy_debit_notes SET status='credited',credit_note_no=$3,credit_note_date=$4,credited_amount=$5,credited_by=$6,credited_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, note.id, creditNoteNo, creditNoteDate, amount.toFixed(2), user.id]);
    await repo.audit(db, business.id, user.id, 'pharmacy.debit_note_credited', note.id, { noteNo: note.note_no, creditNoteNo, amount: amount.toFixed(2), claimed: note.claimed });
    return debitNoteDetail(db, business, note.id);
  });
}

module.exports = { requirePharmacy, saveDrug, drug, substitutes, sell, prescription, invoiceExtras, registerSummary, createRecall, recall, updateRecall,
  nearExpiry, createDebitNote, debitNote, creditDebitNote, SCHEDULED };
