const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const numbering = require('../../core/services/businessNumbering');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const { phoneDigits } = require('./businessElectronics.service');
// Round 2: advance refunds and the manager's PIN (shared with the salon).
const refunds = () => require('../../salon-weight/services/businessAdvanceRefunds');
const pins = () => require('../../salon-weight/services/businessManagerPin');
const FREE_SQL = (k) => `${k}.amount-COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=${k}.business_id AND p.collection_id=${k}.id),0)
  -COALESCE((SELECT sum(f.amount) FROM business_collection_refunds f WHERE f.business_id=${k}.business_id AND f.collection_id=${k}.id),0)`;

// Repair jobs (electronics & mobiles service desk).
//
//   intake     a job card (RJ/2627/0001): customer, device, serial / IMEI,
//              problem, accessories left with the device, estimate, promised
//              date. A serial with a live warranty marks the job "under warranty".
//   work       status received → diagnosing → waiting for parts → in repair →
//              ready (and back while open); each change is kept in the history.
//   parts and  lines at the price the customer will pay (0 under warranty):
//   charges    parts are goods from stock, labour is a service item.
//   delivery   the lines become a sale bill (SI/…) posted by the core, with the
//              payment taken; the parts leave stock only now — the explicit
//              rule — so a part not in stock at the job's location stops the
//              delivery until it is received. Nothing to bill: no bill.
//   cancel     the device goes back unrepaired, with a reason; nothing is billed.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const hashOf = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const derivedKey = (key, part) => {
  const h = crypto.createHash('sha256').update(`${key}:${part}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const OPEN = ['received', 'diagnosing', 'waiting_parts', 'in_repair', 'awaiting_approval', 'ready'];
// The first move listed is the usual next step (the screen's main button).
// "Awaiting approval" (pro pass E-19): the charges are more than the
// estimate, or the technician asks; the customer approves (work goes on) or
// declines (the device goes back unrepaired) through `approval` below.
const MOVES = {
  received: ['diagnosing', 'waiting_parts', 'in_repair', 'awaiting_approval', 'ready'],
  diagnosing: ['in_repair', 'waiting_parts', 'awaiting_approval', 'ready'],
  waiting_parts: ['in_repair', 'diagnosing', 'awaiting_approval', 'ready'],
  in_repair: ['ready', 'waiting_parts', 'awaiting_approval'],
  awaiting_approval: [],
  ready: ['in_repair'],
};
const WORDS = { received: 'Received', diagnosing: 'Diagnosing', waiting_parts: 'Waiting for parts', in_repair: 'In repair', awaiting_approval: 'Awaiting customer approval',
  ready: 'Ready for pickup', delivered: 'Delivered', cancelled: 'Cancelled' };
const CHECK_KEY = /^[a-z][a-z_]{1,29}$/;
// Damage and condition seen at intake: { screen_cracked: true, water_damage: false, … }.
function readChecklist(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) fail('The checklist must be a list of ticks');
  const entries = Object.entries(value);
  if (entries.length > 20) fail('At most 20 checklist items');
  return Object.fromEntries(entries.map(([k, x]) => {
    if (!CHECK_KEY.test(k)) fail('Unknown checklist item');
    return [k, x === true];
  }));
}
// The screen lock / pattern the customer left, kept only while the job is open.
const readPasscode = (value) => v.optionalString(value, 'Screen lock / pattern', 60);

function requireRepairs(business) {
  if (!business.modules.includes('repairs')) fail('Repairs & service is not switched on for this business. An owner can turn it on in Settings › Modules.', 403);
}
async function lockJob(db, business, jobId) {
  // Same lock order as every posting: the business, then the record.
  await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
  const job = await repo.one(db, 'SELECT * FROM electronics_repair_jobs WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(jobId, 'Repair job')]);
  if (!job) fail('Repair job not found', 404);
  return job;
}
const requireOpen = (job) => { if (!OPEN.includes(job.status)) fail(`Repair job ${job.job_no} is ${WORDS[job.status].toLowerCase()} and closed`, 409); };
async function history(db, business, user, job, from, to, note) {
  await db.query('INSERT INTO electronics_repair_events(business_id,job_id,from_status,to_status,note,created_by) VALUES($1,$2,$3,$4,$5,$6)',
    [business.id, job.id, from, to, note || null, user.id]);
}

async function intake(business, user, body) {
  await access.require(business, 'repairs.create');
  requireRepairs(business);
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const problem = v.requiredString(body.problem, 'Problem reported', 1000);
  const estimate = body.estimate === undefined || body.estimate === null || body.estimate === '' ? null : core.decimal(body.estimate, 'Estimate');
  const promisedOn = body.promisedOn ? core.dateText(body.promisedOn, 'Promised date') : null;
  const serial = v.optionalString(body.serial, 'Serial / IMEI', 100);
  const checklist = readChecklist(body.checklist);
  const passcode = readPasscode(body.passcode);
  let advance = null;
  if (body.advance !== undefined && body.advance !== null && body.advance !== '') {
    if (typeof body.advance !== 'object' || Array.isArray(body.advance)) fail('Advance must be an amount and how it was paid');
    const amount = core.decimal(body.advance.amount ?? 0, 'Advance');
    if (amount > 0) {
      await access.require(business, 'sales.edit');
      // `methodId`: one of the business's own payment methods (no cheques).
      advance = { amount, ...await paymentMethods.pick(repo.pool, business.id, body.advance, 'Advance paid by', ['cash', 'card', 'upi', 'bank']), reference: v.optionalString(body.advance.reference, 'Reference', 100) };
    }
  }
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM electronics_repair_jobs WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for a different repair job', 409);
      return old;
    }
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.locationId, 'Location')]);
    if (!location) fail('Location not found', 404);
    let contact = null;
    if (body.contactId) {
      contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' AND active", [business.id, id(body.contactId, 'Customer')]);
      if (!contact) fail('Customer not found', 404);
    }
    const customerName = v.optionalString(body.customerName, 'Customer name', 150) || contact?.name;
    if (!customerName) fail('Enter the customer\'s name');
    const customerPhone = v.optionalString(body.customerPhone, 'Customer phone', 30) || contact?.phone;
    if (!customerPhone) fail('Enter the customer\'s phone number, to call them when it is ready');
    // An advance is the customer's money on account: a customer record is
    // needed (found by phone, or made from the name and phone).
    if (advance && !contact) {
      const digits = phoneDigits(customerPhone, 'Customer phone');
      contact = await repo.one(db, `SELECT * FROM business_contacts WHERE business_id=$1 AND kind='customer' AND active
        AND right(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$2 ORDER BY id LIMIT 1`, [business.id, digits]);
      if (!contact) {
        contact = await repo.one(db, "INSERT INTO business_contacts(business_id,kind,name,phone) VALUES($1,'customer',$2,$3) RETURNING *", [business.id, customerName, customerPhone]);
        await repo.audit(db, business.id, user.id, 'contact.created', contact.id, { name: contact.name, from: 'repair_intake' });
      }
    }
    let sku = null;
    if (body.skuId) {
      sku = await repo.one(db, 'SELECT id,label FROM catalog_skus WHERE business_id=$1 AND id=$2', [business.id, id(body.skuId, 'Model')]);
      if (!sku) fail('Model not found', 404);
    }
    const device = v.optionalString(body.device, 'Device', 150) || sku?.label;
    if (!device) fail('Describe the device (brand, model, colour)');
    // A live warranty on this serial puts the job under warranty.
    let warranty = null;
    if (serial && business.modules.includes('warranties')) {
      warranty = await repo.one(db, `SELECT w.id,w.ends_on FROM electronics_warranties w JOIN businesses b ON b.id=w.business_id
        LEFT JOIN electronics_serial_details d ON d.business_id=w.business_id AND d.sku_id=w.sku_id AND d.serial=w.serial
        WHERE w.business_id=$1 AND (w.serial=$2 OR d.imei2=$2) AND w.status='active'
          AND (now() AT TIME ZONE b.timezone)::date BETWEEN w.starts_on AND w.ends_on
          AND COALESCE((SELECT sum(quantity) FROM business_return_lines rl WHERE rl.business_id=w.business_id AND rl.line_id=w.line_id),0) = 0
        ORDER BY w.id DESC LIMIT 1`, [business.id, serial]);
    }
    const number = await numbering.nextNumber(db, business.id, location.id, 'repair_job', user.id);
    let collection = null;
    if (advance) {
      const receipt = await numbering.nextNumber(db, business.id, location.id, 'collection', user.id);
      collection = await repo.one(db, `INSERT INTO business_collections(business_id,location_id,collection_no,series_id,contact_id,contact_name,amount,method,reference,notes,request_key,request_hash,created_by,method_name)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, [business.id, location.id, receipt.number, receipt.seriesId, contact.id, contact.name,
        advance.amount.toFixed(2), advance.method, advance.reference, `Advance on repair ${number.number}`, derivedKey(requestKey, 'advance'), hash, user.id, advance.methodName]);
      await repo.audit(db, business.id, user.id, 'collection.recorded', collection.id, { amount: collection.amount, method: collection.method, repairJob: number.number });
      await repo.event(db, business.id, user.id, 'collection.recorded', 'collection', collection.id, {
        collectionNo: collection.collection_no, contactId: contact.id, amount: collection.amount, method: collection.method });
    }
    const job = await repo.one(db, `INSERT INTO electronics_repair_jobs(business_id,location_id,job_no,series_id,contact_id,customer_name,customer_phone,phone_digits,
        sku_id,device,serial,warranty_id,under_warranty,problem,accessories,condition_notes,estimate,promised_on,technician,request_key,request_hash,created_by,
        passcode,checklist,advance_collection_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING *`,
    [business.id, location.id, number.number, number.seriesId, contact?.id || null, customerName, customerPhone, phoneDigits(customerPhone, 'Customer phone'),
      sku?.id || null, device, serial, warranty?.id || null, Boolean(warranty), problem, v.optionalString(body.accessories, 'Accessories', 300),
      v.optionalString(body.conditionNotes, 'Condition', 500), estimate, promisedOn, v.optionalString(body.technician, 'Technician', 100), requestKey, hash, user.id,
      passcode, JSON.stringify(checklist), collection?.id || null]);
    const notes = [warranty ? 'Under warranty' : null, collection ? `Advance ${collection.amount} (${collection.collection_no})` : null,
      body.warrantyOwnerConfirmed ? 'Brought in by someone other than the warranty owner (confirmed at the desk)' : null].filter(Boolean);
    await history(db, business, user, job, null, 'received', notes.join(' · ') || null);
    await repo.audit(db, business.id, user.id, 'repair.received', job.id, { jobNo: job.job_no, underWarranty: job.under_warranty });
    await repo.event(db, business.id, user.id, 'repair.received', 'repair_job', job.id, { jobNo: job.job_no, locationId: location.id, serial, underWarranty: job.under_warranty });
    return job;
  });
}

async function detail(business, jobId) {
  await access.require(business, 'repairs.view');
  requireRepairs(business);
  const job = await repo.one(repo.pool, `SELECT j.*,l.name AS location_name,u.name AS created_by_name,d.document_no,d.total AS bill_total,
      w.ends_on AS warranty_ends_on,w.document_id AS warranty_document_id
    FROM electronics_repair_jobs j JOIN business_locations l ON l.business_id=j.business_id AND l.id=j.location_id
    JOIN users u ON u.id=j.created_by
    LEFT JOIN business_documents d ON d.business_id=j.business_id AND d.id=j.document_id
    LEFT JOIN electronics_warranties w ON w.business_id=j.business_id AND w.id=j.warranty_id
    WHERE j.business_id=$1 AND j.id=$2`, [business.id, id(jobId, 'Repair job')]);
  if (!job) fail('Repair job not found', 404);
  const [lines, events, settings] = await Promise.all([
    repo.all(repo.pool, `SELECT r.*,s.tracking,s.unit,s.tax_rate,
        COALESCE((SELECT sum(quantity) FROM business_stock_lots l WHERE l.business_id=r.business_id AND l.sku_id=r.sku_id AND l.location_id=$3 AND l.lot_code=r.lot_code),0) AS in_stock
      FROM electronics_repair_lines r JOIN catalog_skus s ON s.business_id=r.business_id AND s.id=r.sku_id WHERE r.business_id=$1 AND r.job_id=$2 ORDER BY r.id`, [business.id, job.id, job.location_id]),
    repo.all(repo.pool, `SELECT e.*,u.name AS by_name FROM electronics_repair_events e JOIN users u ON u.id=e.created_by
      WHERE e.business_id=$1 AND e.job_id=$2 ORDER BY e.id`, [business.id, job.id]),
    repo.one(repo.pool, 'SELECT display_name,legal_name,gstin,address_line1,address_line2,city,postal_code,phone,tax_mode,date_format FROM business_settings WHERE business_id=$1', [business.id]),
  ]);
  const charge = lines.reduce((sum, l) => sum + core.lineNet(Number(l.unit_price), Number(l.quantity)), 0);
  const advance = job.advance_collection_id ? await repo.one(repo.pool, `SELECT k.id,k.collection_no,k.amount,k.method,k.created_at,
      ${FREE_SQL('k')} AS free,
      COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=k.business_id AND p.collection_id=k.id),0) AS used,
      COALESCE((SELECT sum(f.amount) FROM business_collection_refunds f WHERE f.business_id=k.business_id AND f.collection_id=k.id),0) AS refunded,
      COALESCE((SELECT json_agg(json_build_object('id',f.id,'refund_no',f.refund_no,'amount',f.amount,'method',f.method,'reference',f.reference,'reason',f.reason,
        'created_at',f.created_at,'approved_by_name',a.name) ORDER BY f.id) FROM business_collection_refunds f JOIN users a ON a.id=f.approved_by
        WHERE f.business_id=k.business_id AND f.collection_id=k.id),'[]') AS refunds
    FROM business_collections k WHERE k.business_id=$1 AND k.id=$2`, [business.id, job.advance_collection_id]) : null;
  const claims = await repo.all(repo.pool, 'SELECT * FROM electronics_warranty_claims WHERE business_id=$1 AND job_id=$2 ORDER BY id', [business.id, job.id]);
  const statusSince = [...events].reverse().find((e) => e.to_status === job.status && e.from_status !== e.to_status)?.created_at || job.created_at;
  return { ...job, passcode: access.can(business, 'repairs.edit') ? job.passcode : (job.passcode ? '••••' : null), lines, events, seller: settings,
    lines_total: (charge / 100).toFixed(2), next: OPEN.includes(job.status) ? MOVES[job.status] : [], advance, claims, status_since: statusSince };
}

async function updateDetails(business, user, jobId, body) {
  await access.require(business, 'repairs.edit');
  requireRepairs(business);
  return repo.transaction(async (db) => {
    const job = await lockJob(db, business, jobId);
    requireOpen(job);
    const estimate = body.estimate === undefined ? job.estimate : body.estimate === null || body.estimate === '' ? null : core.decimal(body.estimate, 'Estimate');
    const promisedOn = body.promisedOn === undefined ? job.promised_on : body.promisedOn ? core.dateText(body.promisedOn, 'Promised date') : null;
    const row = await repo.one(db, `UPDATE electronics_repair_jobs SET problem=$3,accessories=$4,condition_notes=$5,estimate=$6,promised_on=$7,technician=$8,
      passcode=$9,checklist=$10,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, job.id,
      body.problem === undefined ? job.problem : v.requiredString(body.problem, 'Problem reported', 1000),
      body.accessories === undefined ? job.accessories : v.optionalString(body.accessories, 'Accessories', 300),
      body.conditionNotes === undefined ? job.condition_notes : v.optionalString(body.conditionNotes, 'Condition', 500),
      estimate, promisedOn, body.technician === undefined ? job.technician : v.optionalString(body.technician, 'Technician', 100),
      body.passcode === undefined ? job.passcode : readPasscode(body.passcode),
      JSON.stringify(body.checklist === undefined ? job.checklist : readChecklist(body.checklist))]);
    await repo.audit(db, business.id, user.id, 'repair.updated', job.id, { estimate: row.estimate, promisedOn: row.promised_on });
    return row;
  });
}

async function setStatus(business, user, jobId, body) {
  await access.require(business, 'repairs.edit');
  requireRepairs(business);
  const status = v.requiredEnum(body.status, 'Status', Object.keys(MOVES));
  const note = v.optionalString(body.note, 'Note', 500);
  return repo.transaction(async (db) => {
    const job = await lockJob(db, business, jobId);
    requireOpen(job);
    if (!MOVES[job.status].includes(status)) fail(`A job that is ${WORDS[job.status].toLowerCase()} cannot move to ${WORDS[status].toLowerCase()}`, 409);
    const row = await repo.one(db, 'UPDATE electronics_repair_jobs SET status=$3,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *', [business.id, job.id, status]);
    await history(db, business, user, job, job.status, status, note);
    await repo.audit(db, business.id, user.id, 'repair.status_changed', job.id, { from: job.status, to: status });
    await repo.event(db, business.id, user.id, 'repair.status_changed', 'repair_job', job.id, { jobNo: job.job_no, from: job.status, to: status });
    return row;
  });
}

async function addLine(business, user, jobId, body) {
  await access.require(business, 'repairs.edit');
  requireRepairs(business);
  const kind = v.requiredEnum(body.kind, 'Line', ['part', 'labour']);
  const quantity = core.decimal(body.quantity ?? 1, 'Quantity', 3, 0.001, 1000);
  return repo.transaction(async (db) => {
    const job = await lockJob(db, business, jobId);
    requireOpen(job);
    const sku = await repo.one(db, `SELECT s.*,p.kind AS product_kind,u.decimals FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit WHERE s.business_id=$1 AND s.id=$2 AND s.active AND p.active`, [business.id, id(body.skuId, 'Item')]);
    if (!sku) fail('Item not found', 404);
    if (kind === 'labour' && sku.product_kind !== 'service') fail('Labour and charges use a service item (for example "Repair labour")');
    if (kind === 'part' && sku.product_kind !== 'goods') fail('A part is an item kept in stock');
    if (sku.decimals === 0 && !Number.isInteger(quantity)) fail(`${sku.label} is counted in whole units`);
    let lotCode = '';
    if (kind === 'part' && ['batch', 'serial'].includes(sku.tracking)) {
      lotCode = v.requiredString(body.lotCode, 'Batch / serial of the part', 100);
      if (sku.tracking === 'serial' && quantity !== 1) fail('A serial-numbered part is fitted one at a time');
      const lot = await repo.one(db, 'SELECT id FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3 LIMIT 1', [business.id, sku.id, lotCode]);
      if (!lot) fail(`${lotCode} has not been received for ${sku.label}`, 404);
    }
    // Under warranty the customer pays nothing unless a price is typed.
    const unitPrice = body.unitPrice === undefined || body.unitPrice === null || body.unitPrice === ''
      ? (job.under_warranty ? 0 : Number(sku.price)) : core.decimal(body.unitPrice, 'Price');
    const line = await repo.one(db, `INSERT INTO electronics_repair_lines(business_id,job_id,kind,sku_id,lot_code,label,quantity,unit_price,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [business.id, job.id, kind, sku.id, lotCode, v.optionalString(body.label, 'Description', 150) || sku.label, quantity, unitPrice.toFixed(2), user.id]);
    await db.query('UPDATE electronics_repair_jobs SET updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, job.id]);
    await repo.audit(db, business.id, user.id, 'repair.line_added', job.id, { lineId: line.id, kind, skuId: sku.id, quantity, unitPrice });
    // Charges now above the estimate the customer agreed: ask them first.
    let awaitingApproval = false;
    if (job.estimate !== null && ['received', 'diagnosing', 'waiting_parts', 'in_repair'].includes(job.status)) {
      const total = await repo.one(db, 'SELECT COALESCE(sum(round(quantity*unit_price,2)),0) AS total FROM electronics_repair_lines WHERE business_id=$1 AND job_id=$2', [business.id, job.id]);
      if (Math.round(Number(total.total) * 100) > Math.round(Number(job.estimate) * 100)) {
        await db.query("UPDATE electronics_repair_jobs SET status='awaiting_approval',updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, job.id]);
        await history(db, business, user, job, job.status, 'awaiting_approval', `Charges ${Number(total.total).toFixed(2)} are more than the estimate ${Number(job.estimate).toFixed(2)}: ask the customer`);
        await repo.event(db, business.id, user.id, 'repair.status_changed', 'repair_job', job.id, { jobNo: job.job_no, from: job.status, to: 'awaiting_approval' });
        awaitingApproval = true;
      }
    }
    return { ...line, awaitingApproval };
  });
}

async function removeLine(business, user, jobId, lineId) {
  await access.require(business, 'repairs.edit');
  requireRepairs(business);
  return repo.transaction(async (db) => {
    const job = await lockJob(db, business, jobId);
    requireOpen(job);
    const line = await repo.one(db, 'DELETE FROM electronics_repair_lines WHERE business_id=$1 AND job_id=$2 AND id=$3 RETURNING *', [business.id, job.id, id(lineId, 'Line')]);
    if (!line) fail('Line not found', 404);
    await repo.audit(db, business.id, user.id, 'repair.line_removed', job.id, { lineId: line.id, label: line.label, quantity: line.quantity, unitPrice: line.unit_price });
    return { removed: line.id };
  });
}

// Delivery: the job's lines become a sale bill at the prices on the job,
// GST worked out as the business prices (inclusive or exclusive), parts
// leaving stock at the job's location; the payment taken goes on the bill.
async function deliver(business, user, jobId, body) {
  await access.require(business, 'repairs.approve');
  requireRepairs(business);
  const deliveryKey = core.uuid(body.requestKey);
  let paidNow = null;
  if (body.payment !== undefined && body.payment !== null) {
    if (typeof body.payment !== 'object' || Array.isArray(body.payment)) fail('Payment must be an object');
    const amount = core.decimal(body.payment.amount ?? 0, 'Amount paid now');
    if (amount > 0) paidNow = { amount, ...await paymentMethods.pick(repo.pool, business.id, body.payment, 'Payment method', ['cash', 'card', 'upi', 'bank']), reference: v.optionalString(body.payment.reference, 'Reference', 100) };
  }
  const note = v.optionalString(body.note, 'Note', 500);
  return repo.transaction(async (db) => {
    const job = await lockJob(db, business, jobId);
    if (job.status === 'delivered' && job.delivery_key === deliveryKey) return job;
    requireOpen(job);
    if (job.status !== 'ready') fail('Mark the job ready for pickup before delivering it', 409);
    const lines = await repo.all(db, 'SELECT r.*,s.tax_rate FROM electronics_repair_lines r JOIN catalog_skus s ON s.business_id=r.business_id AND s.id=r.sku_id WHERE r.business_id=$1 AND r.job_id=$2 ORDER BY r.id', [business.id, job.id]);
    let document = null, advance = null;
    if (lines.length) {
      await access.require(business, 'sales.create');
      if (paidNow) await access.require(business, 'sales.edit');
      const settings = await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]);
      const inclusive = settings?.tax_mode === 'inclusive';
      // The job's own prices, with GST worked out exactly as a sale would.
      const fixed = lines.map((l) => {
        const gross = core.lineNet(Number(l.unit_price), Number(l.quantity));
        const net = inclusive ? core.inclusiveNet(gross, Number(l.tax_rate)) : gross;
        return { price: Number(l.unit_price), net, tax: inclusive ? gross - net : core.lineTax(gross, Number(l.tax_rate)), priceRuleId: null };
      });
      const saleLines = lines.map((l) => ({ skuId: l.sku_id, quantity: l.quantity, ...(l.lot_code ? { lotCode: l.lot_code } : {}) }));
      const saleBody = { kind: 'sale', locationId: job.location_id, contactId: job.contact_id, lines: saleLines,
        notes: `Repair ${job.job_no} · ${job.device}${job.serial ? ` · ${job.serial}` : ''}${job.under_warranty ? ' · under warranty' : ''}`.slice(0, 500) };
      // The advance taken at intake pays first; the rest is what is collected now.
      let advanceUse = 0;
      if (job.advance_collection_id) {
        const free = await repo.one(db, `SELECT ${FREE_SQL('k')} AS free,k.collection_no,k.method
          FROM business_collections k WHERE k.business_id=$1 AND k.id=$2`, [business.id, job.advance_collection_id]);
        advance = free;
        advanceUse = Math.max(0, Math.round(Number(free.free) * 100));
      }
      document = await core.postDocument(db, business, user, saleBody, { kind: 'sale', requestKey: deliveryKey, hash: hashOf(saleBody), lines: saleLines, paidNow: null, fixed });
      const total = Math.round(Number(document.total) * 100);
      const fromAdvance = Math.min(advanceUse, total);
      if (fromAdvance > 0) {
        await core.recordPayment(db, business, user, document, { amount: (fromAdvance / 100).toFixed(2), method: advance.method, reference: advance.collection_no,
          key: derivedKey(deliveryKey, 'advance'), collectionId: job.advance_collection_id });
      }
      if (paidNow) {
        if (Math.round(paidNow.amount * 100) > total - fromAdvance) fail(`Only ${((total - fromAdvance) / 100).toFixed(2)} is left to pay after the advance`);
        await core.recordPayment(db, business, user, document, { ...paidNow, amount: paidNow.amount.toFixed(2), key: derivedKey(deliveryKey, 'payment') });
      }
    } else if (paidNow) {
      fail('Nothing was charged on this job, so there is nothing to pay');
    }
    const row = await repo.one(db, `UPDATE electronics_repair_jobs SET status='delivered',document_id=$3,delivered_at=now(),delivery_key=$4,passcode=NULL,updated_at=now()
      WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, job.id, document?.id || null, deliveryKey]);
    await history(db, business, user, job, job.status, 'delivered', note || (document ? `Bill ${document.document_no}` : 'Nothing to bill'));
    await repo.audit(db, business.id, user.id, 'repair.delivered', job.id, { jobNo: job.job_no, documentId: document?.id || null, total: document?.total || '0.00' });
    await repo.event(db, business.id, user.id, 'repair.delivered', 'repair_job', job.id, { jobNo: job.job_no, documentId: document?.id || null, documentNo: document?.document_no || null, total: document?.total || '0.00' });
    return row;
  });
}

async function cancelJob(business, user, jobId, body) {
  await access.require(business, 'repairs.cancel');
  requireRepairs(business);
  const reason = v.requiredString(body.reason, 'Reason', 300);
  return repo.transaction(async (db) => {
    const job = await lockJob(db, business, jobId);
    requireOpen(job);
    const row = await repo.one(db, "UPDATE electronics_repair_jobs SET status='cancelled',closed_reason=$3,passcode=NULL,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *", [business.id, job.id, reason]);
    await history(db, business, user, job, job.status, 'cancelled', reason);
    await repo.audit(db, business.id, user.id, 'repair.cancelled', job.id, { reason });
    await repo.event(db, business.id, user.id, 'repair.cancelled', 'repair_job', job.id, { jobNo: job.job_no, reason });
    return row;
  });
}

// The customer's answer when the job waits for approval (E-19): approved
// (the work goes on where it was, the estimate becomes the charges so far)
// or declined (the device goes back unrepaired; nothing is billed).
async function approval(business, user, jobId, body) {
  await access.require(business, 'repairs.edit');
  requireRepairs(business);
  const decision = v.requiredEnum(body.decision, 'Customer\'s answer', ['approved', 'declined']);
  const note = v.optionalString(body.note, 'Note', 500);
  if (decision === 'declined') await access.require(business, 'repairs.cancel');
  return repo.transaction(async (db) => {
    const job = await lockJob(db, business, jobId);
    if (job.status !== 'awaiting_approval') fail(`${job.job_no} is not waiting for the customer's approval`, 409);
    if (decision === 'declined') {
      const reason = `Customer declined the charges${note ? `: ${note}` : ''}`.slice(0, 300);
      const row = await repo.one(db, "UPDATE electronics_repair_jobs SET status='cancelled',closed_reason=$3,passcode=NULL,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *", [business.id, job.id, reason]);
      await history(db, business, user, job, job.status, 'cancelled', reason);
      await repo.audit(db, business.id, user.id, 'repair.cancelled', job.id, { reason });
      await repo.event(db, business.id, user.id, 'repair.cancelled', 'repair_job', job.id, { jobNo: job.job_no, reason });
      return row;
    }
    const back = await repo.one(db, `SELECT from_status FROM electronics_repair_events WHERE business_id=$1 AND job_id=$2 AND to_status='awaiting_approval' AND from_status IS NOT NULL
      AND from_status<>'awaiting_approval' ORDER BY id DESC LIMIT 1`, [business.id, job.id]);
    const to = back && ['received', 'diagnosing', 'waiting_parts', 'in_repair'].includes(back.from_status) ? (back.from_status === 'received' ? 'in_repair' : back.from_status) : 'in_repair';
    const total = await repo.one(db, 'SELECT COALESCE(sum(round(quantity*unit_price,2)),0) AS total FROM electronics_repair_lines WHERE business_id=$1 AND job_id=$2', [business.id, job.id]);
    const estimate = body.estimate === undefined || body.estimate === null || body.estimate === ''
      ? (Number(total.total) > Number(job.estimate || 0) ? Number(total.total) : job.estimate) : core.decimal(body.estimate, 'Agreed estimate');
    const row = await repo.one(db, 'UPDATE electronics_repair_jobs SET status=$3,estimate=$4,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *', [business.id, job.id, to, estimate]);
    await history(db, business, user, job, job.status, to, `Customer approved${estimate !== null ? ` (${Number(estimate).toFixed(2)})` : ''}${note ? `: ${note}` : ''}`);
    await repo.audit(db, business.id, user.id, 'repair.approved', job.id, { estimate });
    await repo.event(db, business.id, user.id, 'repair.status_changed', 'repair_job', job.id, { jobNo: job.job_no, from: job.status, to });
    return row;
  });
}

// A message or call to the customer, kept in the job's history (E-18). The
// message itself goes from the person's own WhatsApp (a wa.me link).
async function logMessage(business, user, jobId, body) {
  await access.require(business, 'repairs.view');
  requireRepairs(business);
  const channel = v.requiredEnum(body.channel ?? 'whatsapp', 'How', ['whatsapp', 'call', 'sms']);
  const stage = v.requiredEnum(body.stage ?? 'update', 'Message', ['received', 'parts', 'approval', 'ready', 'delayed', 'reminder', 'update']);
  return repo.transaction(async (db) => {
    const job = await lockJob(db, business, jobId);
    const words = { whatsapp: 'WhatsApp sent', call: 'Called the customer', sms: 'SMS sent' };
    const what = { received: 'job received', parts: 'waiting for parts', approval: 'approval asked', ready: 'ready to collect', delayed: 'delay', reminder: 'collection reminder', update: 'update' };
    const note = `${words[channel]}: ${what[stage]}${body.note ? ` · ${v.optionalString(body.note, 'Note', 300)}` : ''}`.slice(0, 500);
    await history(db, business, user, job, job.status, job.status, note);
    await repo.audit(db, business.id, user.id, 'repair.customer_told', job.id, { channel, stage });
    return { logged: true, note };
  });
}

// Open jobs by status for the board's chips (E-25).
async function counts(business) {
  await access.require(business, 'repairs.view');
  requireRepairs(business);
  return repo.one(repo.pool, `SELECT count(*) FILTER (WHERE j.status NOT IN ('delivered','cancelled'))::int AS open,
      count(*) FILTER (WHERE j.status='received')::int AS received, count(*) FILTER (WHERE j.status='diagnosing')::int AS diagnosing,
      count(*) FILTER (WHERE j.status='waiting_parts')::int AS waiting_parts, count(*) FILTER (WHERE j.status='in_repair')::int AS in_repair,
      count(*) FILTER (WHERE j.status='awaiting_approval')::int AS awaiting_approval, count(*) FILTER (WHERE j.status='ready')::int AS ready,
      count(*) FILTER (WHERE j.status NOT IN ('ready','delivered','cancelled') AND j.promised_on < (now() AT TIME ZONE b.timezone)::date)::int AS overdue,
      count(*) FILTER (WHERE j.status='ready' AND j.updated_at < now() - interval '3 days')::int AS not_collected
    FROM electronics_repair_jobs j JOIN businesses b ON b.id=j.business_id WHERE j.business_id=$1`, [business.id]);
}

const lists = {
  'repair-jobs': { sql: `SELECT j.id,j.job_no,j.location_id,j.contact_id,j.customer_name,j.customer_phone,j.device,j.serial,j.under_warranty,j.problem,j.estimate,
      (SELECT max(e.created_at) FROM electronics_repair_events e WHERE e.business_id=j.business_id AND e.job_id=j.id AND e.to_status=j.status AND e.from_status IS DISTINCT FROM e.to_status) AS status_since,
      (j.status='ready' AND j.updated_at < now() - interval '3 days') AS not_collected,
      j.promised_on,j.technician,j.status,j.document_id,j.delivered_at,j.created_at,j.updated_at,l.name AS location_name,d.document_no,d.total AS bill_total,
      (SELECT count(*)::int FROM electronics_repair_lines r WHERE r.business_id=j.business_id AND r.job_id=j.id) AS line_count,
      (j.status NOT IN ('delivered','cancelled') AND j.promised_on IS NOT NULL AND j.promised_on < (now() AT TIME ZONE b.timezone)::date) AS overdue,
      CASE WHEN j.status IN ('delivered','cancelled') THEN 'closed' ELSE 'open' END AS stage,
      k.amount AS advance,CASE WHEN k.id IS NULL THEN NULL ELSE ${FREE_SQL('k')} END AS advance_left,
      (k.id IS NOT NULL AND j.status IN ('delivered','cancelled') AND ${FREE_SQL('k')} > 0) AS advance_to_refund
    FROM electronics_repair_jobs j JOIN businesses b ON b.id=j.business_id
    JOIN business_locations l ON l.business_id=j.business_id AND l.id=j.location_id
    LEFT JOIN business_collections k ON k.business_id=j.business_id AND k.id=j.advance_collection_id
    LEFT JOIN business_documents d ON d.business_id=j.business_id AND d.id=j.document_id WHERE j.business_id=$1`,
  search: ['job_no', 'customer_name', 'customer_phone', 'device', 'serial', 'problem', 'document_no'], date: 'created_at',
  filters: { status: 'status', stage: 'stage', location: 'location_id', overdue: 'overdue', not_collected: 'not_collected', advance_to_refund: 'advance_to_refund' }, order: 'id DESC' },
};

// Round 2 (R2-SVC): the advance taken at intake handed back — when the job
// was returned unrepaired (cancelled), or what is left of it after delivery
// (the bill came to less, or nothing was billed). Cash, UPI or bank, with a
// reason and a manager's PIN (sales.refund); a numbered refund with a receipt.
// body: { amount? (all that is left), method, reference?, reason, approverId?, pin?, requestKey }
async function refundAdvance(business, user, jobId, body) {
  await access.require(business, 'repairs.view');
  requireRepairs(business);
  await access.require(business, 'sales.edit');
  const input = refunds().readRefund(body);
  const approval = await pins().readApproval(business, user, body, 'sales.refund', { reasonLabel: 'Reason for the refund' });
  return repo.transaction(async (db) => {
    const job = await lockJob(db, business, jobId);
    if (!job.advance_collection_id) fail(`${job.job_no} has no advance`, 409);
    if (OPEN.includes(job.status)) fail(`${job.job_no} is still open: the advance is taken off the bill at delivery. Return the device unrepaired first to refund it.`, 409);
    const { refund, repeated } = await refunds().refundCollection(db, business, user, { collectionId: job.advance_collection_id, contactId: job.contact_id, input, approval,
      source: 'repair', repairJobId: job.id, label: job.job_no });
    if (!repeated) await history(db, business, user, job, job.status, job.status, `Advance refunded: ${refund.amount} by ${refund.method} (${refund.refund_no}) — ${approval.reason}`.slice(0, 500));
    return { ...refund, job_no: job.job_no, repeated };
  });
}

module.exports = { refundAdvance, intake, detail, updateDetails, setStatus, addLine, removeLine, deliver, cancelJob, approval, logMessage, counts, lists, MOVES };
