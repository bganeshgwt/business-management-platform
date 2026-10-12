const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const returns = require('../../core/services/businessReturns.service');
const electronics = require('./businessElectronics.service');

// Electronics, pro pass (builder E, 7 Oct 2026):
//   receiving   a box of phones in one go: the model and cost once, then
//               IMEI 1 / IMEI 2 per unit, checked, on one purchase (E-15);
//   faulty      a DOA or faulty unit is kept out of sale (the database
//               refuses to bill it) until it goes back to the supplier on a
//               purchase return, is found fine, or is written off; an
//               exchange links the bad unit, the replacement and the claim,
//               and moves the warranty to the replacement (E-17);
//   claims      what a warranty repair is claimed back from the brand or
//               distributor: raised, submitted, approved, rejected, credited (E-21).

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const hashOf = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const derivedKey = (key, part) => {
  const h = crypto.createHash('sha256').update(`${key}:${part}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// --- Receiving units by scanning ---------------------------------------------------------

async function receive(business, user, body) {
  await access.require(business, 'purchasing.create');
  electronics.requireModule(business, 'serials', 'Serial / IMEI numbers');
  const requestKey = core.uuid(body.requestKey);
  const groups = v.requiredArray(body.lines, 'Models');
  if (!groups.length || groups.length > 20) fail('Add between 1 and 20 models');
  const seen = new Map();
  const lines = [], seconds = [];
  for (const group of groups) {
    const skuId = id(group?.skuId, 'Model');
    const unitPrice = core.decimal(group.unitPrice, 'Cost per unit (before GST)');
    const units = v.requiredArray(group.units, 'Units');
    if (!units.length) fail('Scan at least one unit for each model');
    for (const [index, unit] of units.entries()) {
      const serial = v.requiredString(String(unit?.serial ?? ''), `IMEI / serial of unit ${index + 1}`, 100).replace(/\s+/g, '');
      const imei2 = unit?.imei2 ? String(unit.imei2).replace(/\s+/g, '') : null;
      for (const code of [serial, imei2].filter(Boolean)) {
        if (seen.has(code)) fail(`${code} was scanned twice`);
        seen.set(code, true);
      }
      if (imei2 && !electronics.luhn(imei2)) fail(`IMEI 2 ${imei2} is not valid: 15 digits with a check digit`);
      lines.push({ skuId, quantity: '1', unitPrice: unitPrice.toFixed(2), lotCode: serial });
      if (imei2) seconds.push({ skuId, serial, imei2 });
    }
  }
  if (lines.length > 200) fail('Receive at most 200 units on one bill');
  const hash = hashOf(body);
  return repo.transaction(async (db) => {
    // Up-front checks give one clear sentence per problem (the database checks again).
    const models = await repo.all(db, `SELECT s.id,s.label,s.tracking,COALESCE(m.serial_kind,'serial') AS serial_kind FROM catalog_skus s
      LEFT JOIN electronics_models m ON m.business_id=s.business_id AND m.sku_id=s.id WHERE s.business_id=$1 AND s.id=ANY($2::bigint[])`,
    [business.id, [...new Set(lines.map((l) => l.skuId))]]);
    for (const line of lines) {
      const model = models.find((m) => Number(m.id) === line.skuId);
      if (!model) fail('Model not found', 404);
      if (model.tracking !== 'serial') fail(`${model.label} is not tracked by serial / IMEI`);
      if (model.serial_kind === 'imei' && !electronics.luhn(line.lotCode)) fail(`IMEI ${line.lotCode} (${model.label}) is not valid: 15 digits with a check digit. Check the number on the box.`);
    }
    const old = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (!old) {
      const taken = await repo.one(db, `SELECT lot_code FROM business_stock_lots WHERE business_id=$1 AND lot_code=ANY($2::text[])
        UNION ALL SELECT imei2 FROM electronics_serial_details WHERE business_id=$1 AND imei2=ANY($2::text[]) LIMIT 1`, [business.id, [...seen.keys()]]);
      if (taken) fail(`${taken.lot_code} has already been received`, 409);
    }
    const docBody = { kind: 'purchase', locationId: body.locationId, contactId: body.contactId, lines, supplierBillNo: body.supplierBillNo, supplierBillDate: body.supplierBillDate,
      notes: v.optionalString(body.notes, 'Notes', 500) || `Scanned in: ${lines.length} unit${lines.length === 1 ? '' : 's'}` };
    const doc = await core.postDocument(db, business, user, docBody, { kind: 'purchase', requestKey, hash, lines, paidNow: null });
    if (old) return { document: doc, units: lines.length, repeated: true };
    for (const second of seconds) {
      await db.query(`INSERT INTO electronics_serial_details(business_id,sku_id,serial,imei2,updated_by) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(business_id,sku_id,serial) DO UPDATE SET imei2=EXCLUDED.imei2,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [business.id, second.skuId, second.serial, second.imei2, user.id]);
    }
    await repo.audit(db, business.id, user.id, 'electronics.units_received', doc.id, { documentNo: doc.document_no, units: lines.length, imei2: seconds.length });
    return { document: doc, units: lines.length };
  });
}

// --- Faulty and DOA units ------------------------------------------------------------------

const faultySql = `SELECT f.*,s.label,s.code,c.name AS supplier_name,o.document_no AS sold_no,p.document_no AS purchase_no,r.return_no AS purchase_return_no,
    x.id AS exchange_ref,u.name AS created_by_name,rs.label AS replacement_label,
    (SELECT COALESCE(sum(l.quantity),0) FROM business_stock_lots l WHERE l.business_id=f.business_id AND l.sku_id=f.sku_id AND l.lot_code=f.serial) AS in_stock,
    (SELECT loc.name FROM business_stock_lots l JOIN business_locations loc ON loc.business_id=l.business_id AND loc.id=l.location_id
      WHERE l.business_id=f.business_id AND l.sku_id=f.sku_id AND l.lot_code=f.serial AND l.quantity>0 LIMIT 1) AS location_name
  FROM electronics_faulty_units f
  JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
  LEFT JOIN catalog_skus rs ON rs.business_id=f.business_id AND rs.id=f.replacement_sku_id
  LEFT JOIN business_contacts c ON c.business_id=f.business_id AND c.id=f.supplier_contact_id
  LEFT JOIN business_documents o ON o.business_id=f.business_id AND o.id=f.original_document_id
  LEFT JOIN business_documents p ON p.business_id=f.business_id AND p.id=f.purchase_document_id
  LEFT JOIN business_returns r ON r.business_id=f.business_id AND r.id=f.purchase_return_id
  LEFT JOIN business_exchanges x ON x.business_id=f.business_id AND x.id=f.exchange_id
  JOIN users u ON u.id=f.created_by
  WHERE f.business_id=$1`;

// The receipt a unit first came in on (and so the supplier it goes back to).
const firstReceipt = (db, businessId, skuId, serial) => repo.one(db, `SELECT d.id AS document_id,d.contact_id,dl.id AS line_id,d.location_id FROM business_document_lines dl
  JOIN business_documents d ON d.business_id=dl.business_id AND d.id=dl.document_id AND d.kind='purchase'
  WHERE dl.business_id=$1 AND dl.sku_id=$2 AND dl.lot_code=$3 ORDER BY d.id LIMIT 1`, [businessId, skuId, serial]);

async function insertFaulty(db, business, user, { skuId, serial, kind, reason, documentId = null, exchangeId = null, replacement = null }) {
  const receipt = await firstReceipt(db, business.id, skuId, serial);
  const row = await repo.one(db, `INSERT INTO electronics_faulty_units(business_id,sku_id,serial,kind,reason,original_document_id,exchange_id,replacement_sku_id,replacement_serial,
      supplier_contact_id,purchase_document_id,created_by,updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`,
  [business.id, skuId, serial, kind, reason.slice(0, 300), documentId, exchangeId, replacement?.skuId || null, replacement?.serial || null,
    receipt?.contact_id || null, receipt?.document_id || null, user.id]);
  await repo.audit(db, business.id, user.id, 'electronics.unit_faulty', row.id, { serial, kind, exchangeId, replacement: replacement?.serial || null });
  await repo.event(db, business.id, user.id, 'electronics.unit_faulty', 'faulty_unit', row.id, { skuId, serial, kind, exchangeId, replacementSerial: replacement?.serial || null });
  return row;
}

// From an exchange (same transaction): each faulty unit that came back is
// held for the supplier; the replacement is the unit of the same model that
// went out (or the first serial unit); the warranty moves to it.
async function fromExchange(db, business, user, { doc, sale, exchange, lines, reason }) {
  const outLines = await repo.all(db, `SELECT dl.id,dl.sku_id,dl.lot_code,dl.label,s.tracking FROM business_document_lines dl
    JOIN catalog_skus s ON s.business_id=dl.business_id AND s.id=dl.sku_id WHERE dl.business_id=$1 AND dl.document_id=$2 AND dl.lot_code<>'' ORDER BY dl.id`, [business.id, sale.id]);
  const used = new Set();
  for (const input of lines) {
    const line = await repo.one(db, 'SELECT dl.*,s.tracking FROM business_document_lines dl JOIN catalog_skus s ON s.business_id=dl.business_id AND s.id=dl.sku_id WHERE dl.business_id=$1 AND dl.id=$2',
      [business.id, input.lineId]);
    if (!line || line.tracking !== 'serial' || !line.lot_code) fail('Only a serial-numbered unit can be marked faulty or dead on arrival');
    const replacement = outLines.find((o) => !used.has(o.id) && Number(o.sku_id) === Number(line.sku_id) && o.tracking === 'serial')
      || outLines.find((o) => !used.has(o.id) && o.tracking === 'serial') || null;
    if (replacement) used.add(replacement.id);
    await insertFaulty(db, business, user, { skuId: Number(line.sku_id), serial: line.lot_code, kind: input.faulty,
      reason: `${input.faulty === 'doa' ? 'Dead on arrival' : 'Faulty'}: ${reason}`, documentId: doc.id, exchangeId: exchange.id,
      replacement: replacement ? { skuId: Number(replacement.sku_id), serial: replacement.lot_code } : null });
    // The warranty moves: the old one is cancelled, the replacement gets one
    // for the same customer (unless the sale already registered it).
    if (!business.modules.includes('warranties')) continue;
    const warranty = await repo.one(db, "SELECT * FROM electronics_warranties WHERE business_id=$1 AND line_id=$2 AND status='active'", [business.id, line.id]);
    if (!warranty) continue;
    await db.query(`UPDATE electronics_warranties SET status='cancelled',cancel_reason=$3,cancelled_by=$4,cancelled_at=now() WHERE business_id=$1 AND id=$2`,
      [business.id, warranty.id, `Replaced (${input.faulty === 'doa' ? 'dead on arrival' : 'faulty'})${replacement ? ` by ${replacement.lot_code}` : ''}`.slice(0, 300), user.id]);
    await repo.audit(db, business.id, user.id, 'warranty.cancelled', warranty.id, { reason: 'replaced', replacement: replacement?.lot_code || null });
    if (!replacement) continue;
    const already = await repo.one(db, "SELECT id FROM electronics_warranties WHERE business_id=$1 AND line_id=$2 AND status='active'", [business.id, replacement.id]);
    if (already) continue;
    await electronics.registerOnSale(db, business, user, sale, [{ id: replacement.id, lotCode: replacement.lot_code, sku: { id: replacement.sku_id, tracking: 'serial', label: replacement.label } }],
      { contact: null, buyer: { name: warranty.customer_name, phone: warranty.customer_phone } });
  }
}

// A unit in stock found faulty (no exchange): held back from sale.
async function markFaulty(business, user, body) {
  await access.require(business, 'inventory.edit');
  electronics.requireModule(business, 'serials', 'Serial / IMEI numbers');
  const skuId = id(body.skuId, 'Item');
  const serial = v.requiredString(body.serial, 'Serial / IMEI', 100);
  const kind = v.requiredEnum(body.kind ?? 'faulty', 'Kind', ['doa', 'faulty']);
  const reason = v.requiredString(body.reason, 'What is wrong', 300);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const lot = await repo.one(db, 'SELECT id FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3 AND quantity>0', [business.id, skuId, serial]);
    if (!lot) fail(`${serial} is not in stock here; only a unit in stock can be held for the supplier`, 409);
    const open = await repo.one(db, "SELECT id FROM electronics_faulty_units WHERE business_id=$1 AND sku_id=$2 AND serial=$3 AND status='awaiting_supplier'", [business.id, skuId, serial]);
    if (open) fail(`${serial} is already waiting for the supplier`, 409);
    return insertFaulty(db, business, user, { skuId, serial, kind, reason });
  });
}

async function lockFaulty(db, business, faultyId) {
  await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
  const row = await repo.one(db, 'SELECT * FROM electronics_faulty_units WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(faultyId, 'Faulty unit')]);
  if (!row) fail('Faulty unit not found', 404);
  if (row.status !== 'awaiting_supplier') fail(`${row.serial} is no longer waiting for the supplier`, 409);
  return row;
}

// Back to the supplier: a purchase return on the receipt it came in on.
async function sendToSupplier(business, user, faultyId, body) {
  await access.require(business, 'purchasing.refund');
  await access.require(business, 'inventory.edit');
  const requestKey = core.uuid(body.requestKey);
  const claimNo = v.optionalString(body.claimNo, 'Claim / RMA number', 60);
  const note = v.optionalString(body.note, 'Note', 300);
  return repo.transaction(async (db) => {
    const done = await repo.one(db, 'SELECT f.* FROM electronics_faulty_units f JOIN business_returns r ON r.business_id=f.business_id AND r.id=f.purchase_return_id WHERE f.business_id=$1 AND f.id=$2 AND r.request_key=$3',
      [business.id, id(faultyId, 'Faulty unit'), requestKey]);
    if (done) return done;
    const row = await lockFaulty(db, business, faultyId);
    const receipt = await firstReceipt(db, business.id, row.sku_id, row.serial);
    if (!receipt) fail(`${row.serial} has no purchase receipt here, so it cannot go back on one. Write it off instead.`, 409);
    const lot = await repo.one(db, `SELECT l.location_id,loc.name FROM business_stock_lots l JOIN business_locations loc ON loc.business_id=l.business_id AND loc.id=l.location_id
      WHERE l.business_id=$1 AND l.sku_id=$2 AND l.lot_code=$3 AND l.quantity>0`, [business.id, row.sku_id, row.serial]);
    if (!lot) fail(`${row.serial} is not in stock, so it cannot be sent back`, 409);
    if (Number(lot.location_id) !== Number(receipt.location_id)) {
      const where = await repo.one(db, 'SELECT name FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, receipt.location_id]);
      fail(`${row.serial} is at ${lot.name} but came in at ${where.name}. Move it there first (Stock › Transfers), then send it back.`, 409);
    }
    const purchase = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, receipt.document_id]);
    const reason = `${row.kind === 'doa' ? 'Dead on arrival' : 'Faulty'} ${row.serial}${claimNo ? ` · claim ${claimNo}` : ''}`.slice(0, 300);
    const lines = [{ lineId: receipt.line_id, quantity: '1' }];
    const back = await returns.postReturn(db, business, user, purchase, { reason, requestKey, hash: hashOf({ faultyId: row.id, lines }), lines });
    const updated = await repo.one(db, `UPDATE electronics_faulty_units SET status='sent',purchase_return_id=$3,purchase_document_id=$4,supplier_contact_id=$5,claim_no=$6,
      closed_note=$7,updated_by=$8,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *`,
    [business.id, row.id, back.id, purchase.id, purchase.contact_id, claimNo, note, user.id]);
    await repo.audit(db, business.id, user.id, 'electronics.unit_sent_to_supplier', row.id, { serial: row.serial, returnNo: back.return_no, claimNo });
    return { ...updated, return_no: back.return_no };
  });
}

// Found fine (sellable again) or written off (leaves stock as a correction).
async function closeFaulty(business, user, faultyId, body) {
  await access.require(business, 'inventory.edit');
  const status = v.requiredEnum(body.status, 'Outcome', ['restocked', 'written_off']);
  const note = v.requiredString(body.note, 'Note', 300);
  const requestKey = core.uuid(body.requestKey);
  return repo.transaction(async (db) => {
    const row = await lockFaulty(db, business, faultyId);
    if (status === 'written_off') {
      const lot = await repo.one(db, 'SELECT id FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3 AND quantity>0', [business.id, row.sku_id, row.serial]);
      if (lot) {
        const locked = await returns.lockLot(db, business.id, lot.id);
        await returns.applyAdjustment(db, business, user, locked, -1, `Written off (faulty): ${note}`.slice(0, 300), requestKey);
      }
    }
    const updated = await repo.one(db, 'UPDATE electronics_faulty_units SET status=$3,closed_note=$4,updated_by=$5,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *',
      [business.id, row.id, status, note, user.id]);
    await repo.audit(db, business.id, user.id, `electronics.unit_${status}`, row.id, { serial: row.serial, note });
    return updated;
  });
}

// --- Warranty claims against the brand ---------------------------------------------------------

const CLAIM_STATES = ['raised', 'submitted', 'approved', 'rejected', 'credited'];
const claimSql = `SELECT k.*,j.job_no,j.device,j.serial,j.customer_name,j.status AS job_status,c.name AS supplier_name,u.name AS created_by_name
  FROM electronics_warranty_claims k
  JOIN electronics_repair_jobs j ON j.business_id=k.business_id AND j.id=k.job_id
  LEFT JOIN business_contacts c ON c.business_id=k.business_id AND c.id=k.supplier_contact_id
  JOIN users u ON u.id=k.created_by WHERE k.business_id=$1`;

async function createClaim(business, user, jobId, body) {
  await access.require(business, 'repairs.edit');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const job = await repo.one(db, `SELECT j.*,p.brand FROM electronics_repair_jobs j LEFT JOIN catalog_skus s ON s.business_id=j.business_id AND s.id=j.sku_id
      LEFT JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id WHERE j.business_id=$1 AND j.id=$2 FOR UPDATE OF j`, [business.id, id(jobId, 'Repair job')]);
    if (!job) fail('Repair job not found', 404);
    if (!job.under_warranty) fail('Only a job under warranty is claimed from the brand');
    let supplier = null;
    if (body.supplierId) {
      supplier = await repo.one(db, "SELECT id FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='supplier'", [business.id, id(body.supplierId, 'Supplier')]);
      if (!supplier) fail('Supplier not found', 404);
    }
    // The parts fitted, at what they cost the shop (stock cost where the job is).
    const cost = await repo.one(db, `SELECT COALESCE(sum(r.quantity * COALESCE((SELECT max(l.unit_cost) FROM business_stock_lots l WHERE l.business_id=r.business_id AND l.sku_id=r.sku_id),0)),0)::numeric(16,2) AS cost
      FROM electronics_repair_lines r WHERE r.business_id=$1 AND r.job_id=$2 AND r.kind='part'`, [business.id, job.id]);
    const brand = v.optionalString(body.brand, 'Brand', 100) || job.brand;
    if (!brand) fail('Enter the brand (or distributor) the claim goes to');
    const partCost = body.partCost === undefined || body.partCost === '' || body.partCost === null ? Number(cost.cost) : core.decimal(body.partCost, 'Part cost');
    const row = await repo.one(db, `INSERT INTO electronics_warranty_claims(business_id,job_id,warranty_id,brand,supplier_contact_id,claim_no,part_cost,notes,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`, [business.id, job.id, job.warranty_id, brand, supplier?.id || null,
      v.optionalString(body.claimNo, 'Claim number', 60), partCost.toFixed(2), v.optionalString(body.notes, 'Notes', 500), user.id]);
    await db.query('INSERT INTO electronics_repair_events(business_id,job_id,from_status,to_status,note,created_by) VALUES($1,$2,$3,$3,$4,$5)',
      [business.id, job.id, job.status, `Warranty claim raised with ${brand}${row.claim_no ? ` (${row.claim_no})` : ''}`.slice(0, 500), user.id]);
    await repo.audit(db, business.id, user.id, 'repair.claim_raised', row.id, { jobId: job.id, brand, partCost: row.part_cost });
    return row;
  });
}

async function updateClaim(business, user, claimId, body) {
  await access.require(business, 'repairs.edit');
  return repo.transaction(async (db) => {
    const claim = await repo.one(db, 'SELECT * FROM electronics_warranty_claims WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(claimId, 'Claim')]);
    if (!claim) fail('Claim not found', 404);
    if (['credited', 'rejected'].includes(claim.status)) fail(`This claim is ${claim.status} and closed`, 409);
    const status = body.status === undefined ? claim.status : v.requiredEnum(body.status, 'Claim status', CLAIM_STATES);
    const credited = status === 'credited' ? core.decimal(body.creditedAmount ?? claim.part_cost, 'Amount credited') : null;
    const row = await repo.one(db, `UPDATE electronics_warranty_claims SET status=$3,claim_no=$4,credited_amount=$5,notes=$6,updated_by=$7,updated_at=now()
      WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, claim.id, status,
      body.claimNo === undefined ? claim.claim_no : v.optionalString(body.claimNo, 'Claim number', 60),
      credited === null ? null : credited.toFixed(2), body.notes === undefined ? claim.notes : v.optionalString(body.notes, 'Notes', 500), user.id]);
    await repo.audit(db, business.id, user.id, 'repair.claim_updated', claim.id, { from: claim.status, to: status, credited: row.credited_amount });
    return row;
  });
}

// Pending per brand: raised + submitted + approved, not yet credited.
async function claimSummary(business) {
  await access.require(business, 'repairs.view');
  return repo.all(repo.pool, `SELECT brand,count(*)::int AS claims,sum(part_cost)::numeric(16,2) AS pending
    FROM electronics_warranty_claims WHERE business_id=$1 AND status IN ('raised','submitted','approved') GROUP BY brand ORDER BY sum(part_cost) DESC`, [business.id]);
}

const lists = {
  'faulty-units': { sql: faultySql, search: ['serial', 'label', 'code', 'supplier_name', 'sold_no', 'replacement_serial', 'claim_no'], date: 'created_at',
    filters: { status: 'status' }, order: 'id DESC' },
  'warranty-claims': { sql: claimSql, search: ['brand', 'claim_no', 'job_no', 'device', 'serial', 'customer_name'], date: 'created_at',
    filters: { status: 'status' }, order: 'id DESC' },
};

module.exports = { receive, fromExchange, markFaulty, sendToSupplier, closeFaulty, createClaim, updateClaim, claimSummary, lists, derivedKey };
