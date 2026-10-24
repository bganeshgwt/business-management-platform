const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const numbering = require('../../core/services/businessNumbering');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const c = require('./garageCommon');
const money = require('./garageMoney');
const vehicles = require('./garageVehicles.service');
// Advance refunds and the manager's PIN (shared with the salon, repairs and optical).
const refunds = () => require('../../salon-weight/services/businessAdvanceRefunds');
const pins = () => require('../../salon-weight/services/businessManagerPin');

// Job cards (module "garage", garages).
//
//   open      the vehicle (its registration, as it is now) and the customer
//             (its owner unless another customer pays), the odometer reading
//             and fuel level in, the customer's complaints, inspection notes,
//             the bay, the mechanics, the promised time; an advance taken is a
//             numbered collection receipt (the customer's money on account).
//   estimate  parts, labour and outside work priced as charged, each with who
//             pays it; every save is a new version (garageEstimates.service.js).
//   approval  who approved the estimate as it stands, how (in person, by phone
//             or on WhatsApp), when, for its total. A revision above what the
//             owner approved goes back to them.
//   work      received → estimate sent → approved → in progress ⇄ waiting for
//             parts → ready; a quick job may start without an estimate. A
//             mechanic (garage.edit without garage.view) sees the job cards
//             assigned to them, records the work done and the parts used, and
//             moves the job along; they see no money.
//   bill      at ready: the bills posted by the core (garageBilling.service.js).
//   cancel    with a reason; the advance stays the customer's, handed back from
//             the job card (a manager's PIN) or used on a later bill.
// Money is integer paise; quantities integer thousandths.

const { fail, id } = c;
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
const derivedKey = (key, part) => {
  const h = crypto.createHash('sha256').update(`${key}:${part}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
// What is left of a receipt: less bills it paid and earlier refunds.
const FREE_SQL = (k) => `${k}.amount-COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=${k}.business_id AND p.collection_id=${k}.id),0)
  -COALESCE((SELECT sum(f.amount) FROM business_collection_refunds f WHERE f.business_id=${k}.business_id AND f.collection_id=${k}.id),0)`;
// The usual next steps, by who takes them. The estimate goes to the owner
// from the desk; the owner's approval is recorded, not a step; ready is
// billed and delivered from the desk.
const MOVES = {
  received: ['estimate_sent', 'in_progress', 'waiting_parts', 'ready'],
  estimate_sent: [],
  approved: ['in_progress', 'waiting_parts', 'ready'],
  in_progress: ['ready', 'waiting_parts'],
  waiting_parts: ['in_progress', 'ready'],
  ready: ['in_progress', 'waiting_parts'],
};
const WORK_MOVES = ['in_progress', 'waiting_parts', 'ready'];
const ADVANCE_KINDS = ['cash', 'card', 'upi', 'bank'];
// How far ahead a job card may be promised.
const MAX_PROMISED_DAYS = 365;
const MONEY_FIELDS = ['subtotal', 'tax', 'round_off', 'total', 'bill_total', 'insurer_bill_total', 'advance', 'advance_left', 'bill', 'approval'];
const LINE_MONEY = ['unit_price', 'amount', 'net', 'tax', 'mrp', 'mrp_now'];

// --- Lists ----------------------------------------------------------------------------------

const JOBS_SQL = `SELECT x.*,CASE WHEN x.status IN ('delivered','cancelled') THEN 'closed' ELSE 'open' END AS stage FROM (
  SELECT j.id,j.job_no,j.location_id,j.vehicle_id,j.registration_no,j.vehicle_name,j.contact_id,j.customer_name,j.customer_phone,j.status,j.promised_at,j.bay,
    j.odometer_in,j.total,j.estimate_version,j.approved_version,j.document_id,j.insurer_document_id,j.delivered_at,j.created_at,j.updated_at,j.complaints,
    l.name AS location_name,d.document_no,d.total AS bill_total,i.document_no AS insurer_document_no,i.total AS insurer_bill_total,
    g.mode AS claim_mode,g.claim_no,ins.name AS insurer_name,
    (SELECT string_agg(u.name,', ' ORDER BY u.name) FROM garage_job_card_mechanics m JOIN users u ON u.id=m.user_id WHERE m.business_id=j.business_id AND m.job_card_id=j.id) AS mechanics,
    (j.status NOT IN ('ready','delivered','cancelled') AND j.promised_at < now()) AS overdue,
    k.amount AS advance,CASE WHEN k.id IS NULL THEN NULL ELSE ${FREE_SQL('k')} END AS advance_left,
    (k.id IS NOT NULL AND j.status IN ('delivered','cancelled') AND ${FREE_SQL('k')} > 0) AS advance_to_refund,
    (SELECT max(e.created_at) FROM garage_job_card_events e WHERE e.business_id=j.business_id AND e.job_card_id=j.id AND e.to_status=j.status
      AND e.from_status IS DISTINCT FROM e.to_status) AS status_since
  FROM garage_job_cards j JOIN business_locations l ON l.business_id=j.business_id AND l.id=j.location_id
  LEFT JOIN business_collections k ON k.business_id=j.business_id AND k.id=j.advance_collection_id
  LEFT JOIN business_documents d ON d.business_id=j.business_id AND d.id=j.document_id
  LEFT JOIN business_documents i ON i.business_id=j.business_id AND i.id=j.insurer_document_id
  LEFT JOIN garage_claims g ON g.business_id=j.business_id AND g.job_card_id=j.id
  LEFT JOIN business_contacts ins ON ins.business_id=g.business_id AND ins.id=g.insurer_id
  WHERE j.business_id=$1) x`;
repo.addLists({
  // Every job card, the newest first, with its vehicle, customer, mechanics, claim and bills.
  'garage-job-cards': {
    sql: JOBS_SQL,
    search: ['job_no', 'registration_no', 'vehicle_name', 'customer_name', 'customer_phone', 'document_no', 'insurer_document_no', 'claim_no', 'insurer_name', 'mechanics'],
    date: 'created_at',
    filters: { status: 'status', stage: 'stage', location: 'location_id', vehicle: 'vehicle_id', contact: 'contact_id', overdue: 'overdue', claim: 'claim_mode',
      advance_to_refund: 'advance_to_refund' },
    order: 'id DESC',
  },
});

// What someone who does not see sales sees of a job card: no money.
function withoutMoney(job) {
  const out = { ...job };
  for (const key of MONEY_FIELDS) if (key in out) out[key] = null;
  const lineOf = (l) => Object.fromEntries(Object.entries(l).map(([key, value]) => [key, LINE_MONEY.includes(key) ? null : value]));
  if (Array.isArray(out.lines)) out.lines = out.lines.map(lineOf);
  if (Array.isArray(out.versions)) {
    out.versions = out.versions.map((ver) => ({ ...ver, subtotal: null, tax: null, round_off: null, total: null, insurer_lines: null,
      lines: (ver.lines || []).map((l) => ({ ...l, unitPrice: null, amount: null, net: null, tax: null })) }));
  }
  if (Array.isArray(out.approvals)) out.approvals = out.approvals.map((a) => ({ ...a, amount: null }));
  if (out.claim) out.claim = { ...out.claim, approved_amount: null, deductible: null, depreciation: null };
  return { ...out, money: false };
}
const shape = (business, job) => (c.seesMoney(business) ? { ...job, money: true } : withoutMoney(job));
function listShape(business, page) {
  if (c.seesMoney(business)) return page;
  return { ...page, items: page.items.map((row) => ({ ...row, total: null, bill_total: null, insurer_bill_total: null, advance: null, advance_left: null })) };
}

// --- Reading a request ---------------------------------------------------------------------

// What the customer says, one entry each (at least one: the service asked for counts).
function readComplaints(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : [];
  const complaints = list.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
  if (!complaints.length) fail('Write what the customer says is wrong, or the service they asked for');
  if (complaints.length > 20) fail('A job card holds up to 20 complaints');
  for (const x of complaints) if (x.length > 200) fail('Each complaint is up to 200 characters');
  return complaints;
}

// The promised time: a moment from now to a year ahead. Empty is none.
function readPromised(value) {
  if (!c.given(value)) return null;
  const at = new Date(String(value));
  if (!Number.isFinite(at.getTime())) fail('Promised for must be a date and time');
  if (at.getTime() < Date.now() - 5 * 60000) fail('The promised time cannot be one that has passed');
  if (at.getTime() > Date.now() + MAX_PROMISED_DAYS * 86400000) fail('Promise the vehicle within a year');
  return at.toISOString();
}

function readMechanicIds(value) {
  if (value === undefined || value === null) return [];
  const list = v.requiredArray(value, 'Mechanics');
  if (list.length > 10) fail('A job card has up to 10 mechanics');
  const ids = list.map((x) => id(x, 'Mechanic'));
  if (new Set(ids).size !== ids.length) fail('Each mechanic is named once');
  return ids;
}

// The advance: { amount, method or methodId, reference? } (no cheques). Needs sales.edit.
async function readAdvance(business, value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('The advance must be an amount and how it was paid');
  const amount = core.decimal(value.amount ?? 0, 'Advance');
  if (amount <= 0) return null;
  await access.require(business, 'sales.edit');
  return { amount, ...await paymentMethods.pick(repo.pool, business.id, value, 'Advance paid by', ADVANCE_KINDS), reference: c.optionalText(value.reference, 'Reference', 100) };
}

// Members who may be named as mechanics: their role holds garage.edit.
async function checkMechanics(db, business, ids) {
  if (!ids.length) return [];
  const allowed = await c.mechanics(db, business);
  return ids.map((userId) => {
    const person = allowed.find((m) => Number(m.id) === Number(userId));
    if (!person) fail('A mechanic on a job card is a member of the business whose role works on job cards', 404);
    return person;
  });
}

// --- Reading a job card ---------------------------------------------------------------------------

async function linesOf(db, business, job) {
  return repo.all(db, `SELECT x.*,s.code AS sku_code,s.tracking,s.active AS sku_active,s.internal_use,s.tax_rate AS tax_rate_now,s.mrp AS mrp_now,
      p.kind AS sku_kind,p.active AS product_active,du.name AS done_by_name,au.name AS added_by_name,
      CASE WHEN p.kind<>'goods' THEN NULL ELSE COALESCE((SELECT sum(l.quantity) FROM business_stock_lots l WHERE l.business_id=x.business_id AND l.sku_id=x.sku_id
        AND l.location_id=$3 AND (l.expires_on IS NULL OR l.expires_on >= (now() AT TIME ZONE $4)::date)),0) END AS in_stock
    FROM garage_job_card_lines x JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.sku_id
    JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    JOIN users au ON au.id=x.added_by LEFT JOIN users du ON du.id=x.done_by
    WHERE x.business_id=$1 AND x.job_card_id=$2 ORDER BY x.id`, [business.id, job.id, job.location_id, business.timezone || 'Asia/Kolkata']);
}

async function claimOf(db, business, jobId) {
  return repo.one(db, `SELECT g.*,k.name AS insurer_name,k.gstin AS insurer_gstin,k.pan AS insurer_pan,k.phone AS insurer_phone,k.address AS insurer_address,k.active AS insurer_active
    FROM garage_claims g JOIN business_contacts k ON k.business_id=g.business_id AND k.id=g.insurer_id WHERE g.business_id=$1 AND g.job_card_id=$2`, [business.id, jobId]);
}

// The garage's settings, and the claim-share item with what billing needs of it.
async function settingsOf(db, business) {
  const row = await repo.one(db, `SELECT g.*,u.name AS updated_by_name FROM garage_settings g JOIN users u ON u.id=g.updated_by WHERE g.business_id=$1`, [business.id]);
  const share = row?.claim_share_sku_id ? await repo.one(db, `SELECT s.id,s.label,s.code,s.unit,s.tax_rate,s.hsn_code,(s.active AND p.active) AS active,p.kind,s.internal_use
    FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id WHERE s.business_id=$1 AND s.id=$2`, [business.id, row.claim_share_sku_id]) : null;
  return { service_months: Number(row?.service_months || 6), service_km: Number(row?.service_km || 5000), claim_share_sku_id: row?.claim_share_sku_id || null, share,
    updated_at: row?.updated_at || null, updated_by_name: row?.updated_by_name || null };
}

const ADVANCE_SQL = (k) => `SELECT k.id,k.collection_no,k.amount,k.method,k.method_name,k.created_at,${FREE_SQL(k)} AS free,
    COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=k.business_id AND p.collection_id=k.id),0) AS used,
    COALESCE((SELECT sum(f.amount) FROM business_collection_refunds f WHERE f.business_id=k.business_id AND f.collection_id=k.id),0) AS refunded,
    COALESCE((SELECT json_agg(json_build_object('id',f.id,'refund_no',f.refund_no,'amount',f.amount,'method',f.method,'method_name',f.method_name,'reference',f.reference,
      'reason',f.reason,'created_at',f.created_at,'approved_by_name',a.name) ORDER BY f.id) FROM business_collection_refunds f JOIN users a ON a.id=f.approved_by
      WHERE f.business_id=k.business_id AND f.collection_id=k.id),'[]') AS refunds
  FROM business_collections k WHERE k.business_id=$1 AND k.id=$2`;

// The moves this person may make now.
function nextMoves(business, job) {
  if (!c.OPEN.includes(job.status) || !access.can(business, 'garage.edit')) return [];
  const moves = MOVES[job.status] || [];
  return c.seesAll(business) ? moves.filter((m) => m !== 'estimate_sent' || job.estimate_version > 0) : moves.filter((m) => WORK_MOVES.includes(m));
}

async function load(db, business, jobId) {
  const j = await repo.one(db, `SELECT j.*,l.name AS location_name,to_jsonb(l) AS location,cu.name AS created_by_name,dl.name AS delivered_by_name,cn.name AS cancelled_by_name,
      d.document_no,d.total AS bill_total,i.document_no AS insurer_document_no,i.total AS insurer_bill_total,
      (j.status NOT IN ('ready','delivered','cancelled') AND j.promised_at < now()) AS overdue
    FROM garage_job_cards j JOIN business_locations l ON l.business_id=j.business_id AND l.id=j.location_id
    JOIN users cu ON cu.id=j.created_by LEFT JOIN users dl ON dl.id=j.delivered_by LEFT JOIN users cn ON cn.id=j.cancelled_by
    LEFT JOIN business_documents d ON d.business_id=j.business_id AND d.id=j.document_id
    LEFT JOIN business_documents i ON i.business_id=j.business_id AND i.id=j.insurer_document_id
    WHERE j.business_id=$1 AND j.id=$2`, [business.id, jobId]);
  if (!j) fail('Job card not found', 404);
  access.requireLocation(business, j.location_id);
  // One query at a time: `db` may be a transaction's own client.
  const mechanicRows = await repo.all(db, `SELECT m.user_id AS id,u.name,m.assigned_at FROM garage_job_card_mechanics m JOIN users u ON u.id=m.user_id
    WHERE m.business_id=$1 AND m.job_card_id=$2 ORDER BY u.name`, [business.id, j.id]);
  // A mechanic sees the job cards assigned to them, and no other.
  if (!c.seesAll(business) && !mechanicRows.some((m) => Number(m.id) === Number(business.member_user_id))) fail('Job card not found', 404);
  const lines = await linesOf(db, business, j);
  const vehicle = await repo.one(db, `SELECT v.id,v.registration_no,concat_ws(' ',v.make,v.model,v.variant) AS vehicle_name,v.make,v.model,v.variant,v.fuel,v.year,
      v.chassis_no,v.engine_no,v.odometer_km,v.odometer_at,v.next_service_on,v.next_service_km,v.insurance_expires_on,v.puc_expires_on,v.active,
      v.contact_id AS owner_id,k.name AS owner_name,k.phone AS owner_phone
    FROM garage_vehicles v JOIN business_contacts k ON k.business_id=v.business_id AND k.id=v.contact_id WHERE v.business_id=$1 AND v.id=$2`, [business.id, j.vehicle_id]);
  const versions = await repo.all(db, `SELECT ver.version,ver.subtotal,ver.tax,ver.round_off,ver.total,ver.insurer_lines,ver.source,ver.note,ver.lines,ver.created_at,u.name AS created_by_name
    FROM garage_estimate_versions ver JOIN users u ON u.id=ver.created_by WHERE ver.business_id=$1 AND ver.job_card_id=$2 ORDER BY ver.version`, [business.id, j.id]);
  const approvals = await repo.all(db, `SELECT a.id,a.version,a.amount,a.approved_by,a.channel,a.approved_at,a.note,a.recorded_at,u.name AS recorded_by_name
    FROM garage_estimate_approvals a JOIN users u ON u.id=a.recorded_by WHERE a.business_id=$1 AND a.job_card_id=$2 ORDER BY a.id`, [business.id, j.id]);
  const claim = await claimOf(db, business, j.id);
  const events = await repo.all(db, `SELECT e.id,e.from_status,e.to_status,e.note,e.created_at,u.name AS by_name FROM garage_job_card_events e JOIN users u ON u.id=e.created_by
    WHERE e.business_id=$1 AND e.job_card_id=$2 ORDER BY e.id`, [business.id, j.id]);
  const advance = j.advance_collection_id ? await repo.one(db, ADVANCE_SQL('k'), [business.id, j.advance_collection_id]) : null;
  const settings = await repo.one(db, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]);
  const open = c.OPEN.includes(j.status);
  let bill = null;
  if (open && lines.length) {
    const garage = claim?.mode === 'cashless' ? await settingsOf(db, business) : null;
    const p = money.plan(j, lines, claim, settings?.rounding, garage?.share || null);
    const left = advance ? Math.max(0, money.paise(advance.free)) : 0;
    const own = p.customer ? p.customer.figures.total : 0;
    bill = { ...money.figuresText(p.job), insurer: p.insurer ? money.figuresText(p.insurer.figures) : null, customer: p.customer ? money.figuresText(p.customer.figures) : null,
      advance: money.rupees(Math.min(left, own)), due: money.rupees(Math.max(0, own - left)), problem: p.problem, claim: p.claim,
      rate_changed: lines.some((l) => Number(l.tax_rate_now) !== Number(l.tax_rate)) };
  }
  const latest = approvals.at(-1) || null;
  const statusSince = [...events].reverse().find((e) => e.to_status === j.status && e.from_status !== e.to_status)?.created_at || j.created_at;
  const { request_hash: _hash, location, ...rest } = j;
  return { ...rest, vehicle, lines, mechanics: mechanicRows, versions, approvals, approval: latest ? { version: latest.version, amount: latest.amount, approved_by: latest.approved_by } : null,
    claim: claim || null, events, advance, bill, work: { done: lines.filter((l) => l.done).length, lines: lines.length },
    seller: core.branchSeller(settings, location), next: nextMoves(business, j), status_since: statusSince };
}

async function detail(business, jobId) {
  c.requireGarage(business);
  await access.requireAny(business, ['garage.view', 'garage.edit']);
  return shape(business, await load(repo.pool, business, id(jobId, 'Job card')));
}

// The job card locked for a change (and the business first, the order every
// posting locks in); a mechanic reaches only the job cards assigned to them.
async function lockJob(db, business, jobId) {
  await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
  const job = await repo.one(db, 'SELECT * FROM garage_job_cards WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(jobId, 'Job card')]);
  if (!job) fail('Job card not found', 404);
  access.requireLocation(business, job.location_id);
  if (!c.seesAll(business)) {
    const mine = await repo.one(db, 'SELECT 1 FROM garage_job_card_mechanics WHERE business_id=$1 AND job_card_id=$2 AND user_id=$3', [business.id, job.id, business.member_user_id]);
    if (!mine) fail('Job card not found', 404);
  }
  return job;
}
const requireOpen = (job) => { if (!c.OPEN.includes(job.status)) fail(`Job card ${job.job_no} is ${c.STATUS_WORDS[job.status]} and no longer changes`, 409); };

async function history(db, business, user, job, from, to, note) {
  await db.query('INSERT INTO garage_job_card_events(business_id,job_card_id,from_status,to_status,note,created_by) VALUES($1,$2,$3,$4,$5,$6)',
    [business.id, job.id, from, to, note ? String(note).slice(0, 500) : null, user.id]);
}

// --- Opening a job card ----------------------------------------------------------------------------

// body: { requestKey, locationId, vehicleId, contactId? (the vehicle's owner), odometerKm?, odometerApproval?: { reason, approverId?, pin? },
//   fuelLevel?, complaints: [..], inspectionNotes?, bay?, promisedAt?, mechanicIds?: [..], notes?, advance?: { amount, method | methodId, reference? } }
async function open(business, user, body) {
  c.requireGarage(business);
  await access.require(business, 'garage.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const locationId = id(body.locationId, 'Location');
  const vehicleId = id(body.vehicleId, 'Vehicle');
  const complaints = readComplaints(body.complaints);
  const fuelLevel = v.optionalEnum(body.fuelLevel, 'Fuel level', c.FUEL_LEVELS, null);
  const odometer = c.readKm(body.odometerKm, 'Odometer');
  const promisedAt = readPromised(body.promisedAt);
  const bay = c.optionalText(body.bay, 'Bay', 40);
  const inspection = c.optionalText(body.inspectionNotes, 'Inspection notes', 1000);
  const notes = c.optionalText(body.notes, 'Notes', 500);
  const mechanicIds = readMechanicIds(body.mechanicIds);
  if (mechanicIds.length) await access.require(business, 'garage.edit');
  const advance = await readAdvance(business, body.advance);
  const approval = await vehicles.readLowerApproval(business, user, body.odometerApproval);
  access.requireLocation(business, locationId);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM garage_job_cards WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return shape(business, await load(db, business, old.id));
    }
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId]);
    if (!location) fail('Location not found', 404);
    const vehicle = await vehicles.lockVehicle(db, business, vehicleId);
    if (!vehicle.active) fail(`${vehicle.registration_no} is switched off: switch it on again to open a job card for it`, 409);
    const contactId = c.given(body.contactId) ? id(body.contactId, 'Customer') : vehicle.contact_id;
    const contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' AND active", [business.id, contactId]);
    if (!contact) fail('Customer not found', 404);
    const people = await checkMechanics(db, business, mechanicIds);
    const settings = await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]);
    const number = await numbering.nextNumber(db, business.id, location.id, 'job_card', user.id);
    let collection = null;
    if (advance) {
      const receipt = await numbering.nextNumber(db, business.id, location.id, 'collection', user.id);
      collection = await repo.one(db, `INSERT INTO business_collections(business_id,location_id,collection_no,series_id,contact_id,contact_name,amount,method,reference,notes,request_key,request_hash,created_by,method_name)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, [business.id, location.id, receipt.number, receipt.seriesId, contact.id, contact.name,
        advance.amount.toFixed(2), advance.method, advance.reference, `Advance on job card ${number.number}`, derivedKey(requestKey, 'advance'), hash, user.id, advance.methodName]);
      await repo.audit(db, business.id, user.id, 'collection.recorded', collection.id, { amount: collection.amount, method: collection.method, jobCard: number.number });
      await repo.event(db, business.id, user.id, 'collection.recorded', 'collection', collection.id, {
        collectionNo: collection.collection_no, contactId: contact.id, amount: collection.amount, method: collection.method });
    }
    const vehicleName = [vehicle.make, vehicle.model, vehicle.variant].filter(Boolean).join(' ');
    const saved = await repo.one(db, `INSERT INTO garage_job_cards(business_id,location_id,job_no,series_id,vehicle_id,registration_no,vehicle_name,contact_id,customer_name,customer_phone,
        odometer_in,fuel_level,complaints,inspection_notes,bay,promised_at,tax_mode,notes,advance_collection_id,request_key,request_hash,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$22) RETURNING *`,
    [business.id, location.id, number.number, number.seriesId, vehicle.id, vehicle.registration_no, vehicleName, contact.id, contact.name, contact.phone || null,
      odometer, fuelLevel, complaints, inspection, bay, promisedAt, settings?.tax_mode || 'exclusive', notes, collection?.id || null, requestKey, hash, user.id]);
    if (odometer !== null) await vehicles.recordReading(db, business, user, vehicle, odometer, { source: 'job_in', jobCardId: saved.id, approval });
    for (const person of people) {
      await db.query('INSERT INTO garage_job_card_mechanics(business_id,job_card_id,user_id,assigned_by) VALUES($1,$2,$3,$4)', [business.id, saved.id, person.id, user.id]);
    }
    // The history names the receipt, not the amounts: a mechanic reads it too.
    await history(db, business, user, saved, null, 'received', ['Received', collection ? `advance taken (${collection.collection_no})` : null,
      people.length ? `mechanics: ${c.listWords(people.map((p) => p.name))}` : null].filter(Boolean).join(' · '));
    await repo.audit(db, business.id, user.id, 'job_card.opened', saved.id, { jobNo: saved.job_no, registrationNo: vehicle.registration_no, customer: contact.name,
      ...(odometer !== null ? { odometerKm: odometer } : {}), ...(promisedAt ? { promisedAt } : {}) });
    await repo.event(db, business.id, user.id, 'job_card.opened', 'job_card', saved.id, { jobNo: saved.job_no, locationId: location.id, vehicleId: vehicle.id, contactId: contact.id,
      advanceCollectionId: collection?.id || null, mechanics: people.map((p) => Number(p.id)) });
    return shape(business, await load(db, business, saved.id));
  });
}

// --- Changing a job card ---------------------------------------------------------------------------

// body: { complaints?, inspectionNotes?, bay?, promisedAt?, fuelLevel?, notes? } — what is left out stays.
async function updateDetails(business, user, jobId, body) {
  c.requireGarage(business);
  await c.requireDesk(business);
  return repo.transaction(async (db) => {
    const job = await lockJob(db, business, jobId);
    requireOpen(job);
    const was = { complaints: job.complaints, inspection: job.inspection_notes, bay: job.bay, promisedAt: job.promised_at ? new Date(job.promised_at).toISOString() : null,
      fuelLevel: job.fuel_level, notes: job.notes };
    const now = {
      complaints: body.complaints === undefined ? was.complaints : readComplaints(body.complaints),
      inspection: body.inspectionNotes === undefined ? was.inspection : c.optionalText(body.inspectionNotes, 'Inspection notes', 1000),
      bay: body.bay === undefined ? was.bay : c.optionalText(body.bay, 'Bay', 40),
      // A promised time already passed may stay as it is; a new one is ahead.
      promisedAt: body.promisedAt === undefined || (c.given(body.promisedAt) && was.promisedAt && new Date(body.promisedAt).toISOString() === was.promisedAt) ? was.promisedAt : readPromised(body.promisedAt),
      fuelLevel: body.fuelLevel === undefined ? was.fuelLevel : v.optionalEnum(body.fuelLevel, 'Fuel level', c.FUEL_LEVELS, null),
      notes: body.notes === undefined ? was.notes : c.optionalText(body.notes, 'Notes', 500),
    };
    const changed = Object.keys(now).filter((key) => JSON.stringify(was[key]) !== JSON.stringify(now[key]));
    if (!changed.length) return shape(business, await load(db, business, job.id));
    await db.query(`UPDATE garage_job_cards SET complaints=$3,inspection_notes=$4,bay=$5,promised_at=$6,fuel_level=$7,notes=$8,updated_by=$9,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, job.id, now.complaints, now.inspection, now.bay, now.promisedAt, now.fuelLevel, now.notes, user.id]);
    await repo.audit(db, business.id, user.id, 'job_card.updated', job.id, { jobNo: job.job_no,
      from: Object.fromEntries(changed.map((key) => [key, was[key]])), to: Object.fromEntries(changed.map((key) => [key, now[key]])) });
    const words = { complaints: 'complaints', inspection: 'inspection notes', bay: 'bay', promisedAt: 'promised time', fuelLevel: 'fuel level', notes: 'notes' };
    await history(db, business, user, job, job.status, job.status, `Changed: ${c.listWords(changed.map((key) => words[key]))}`);
    return shape(business, await load(db, business, job.id));
  });
}

// body: { userIds: [..] } — the mechanics working on the job card now (none is allowed).
async function setMechanics(business, user, jobId, body) {
  c.requireGarage(business);
  await c.requireDesk(business);
  const ids = readMechanicIds(body.userIds ?? []);
  return repo.transaction(async (db) => {
    const job = await lockJob(db, business, jobId);
    requireOpen(job);
    const people = await checkMechanics(db, business, ids);
    const before = (await repo.all(db, 'SELECT user_id FROM garage_job_card_mechanics WHERE business_id=$1 AND job_card_id=$2', [business.id, job.id])).map((r) => Number(r.user_id));
    const now = people.map((p) => Number(p.id));
    if (before.length === now.length && before.every((x) => now.includes(x))) return shape(business, await load(db, business, job.id));
    await db.query('DELETE FROM garage_job_card_mechanics WHERE business_id=$1 AND job_card_id=$2 AND NOT (user_id=ANY($3::bigint[]))', [business.id, job.id, now]);
    for (const person of people) {
      if (!before.includes(Number(person.id))) await db.query('INSERT INTO garage_job_card_mechanics(business_id,job_card_id,user_id,assigned_by) VALUES($1,$2,$3,$4)', [business.id, job.id, person.id, user.id]);
    }
    await db.query('UPDATE garage_job_cards SET updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, job.id, user.id]);
    await history(db, business, user, job, job.status, job.status, people.length ? `Mechanics: ${c.listWords(people.map((p) => p.name))}` : 'No mechanic assigned');
    await repo.audit(db, business.id, user.id, 'job_card.mechanics_changed', job.id, { jobNo: job.job_no, from: before, to: now });
    return shape(business, await load(db, business, job.id));
  });
}

// body: { status: estimate_sent | in_progress | waiting_parts | ready, note? }
// Sending the estimate to the owner is the desk's; the work steps are any
// mechanic's on the job card. A job sent back from ready says why.
async function setStatus(business, user, jobId, body) {
  c.requireGarage(business);
  await access.require(business, 'garage.edit');
  const status = v.requiredEnum(body.status, 'Status', ['estimate_sent', ...WORK_MOVES]);
  const note = c.optionalText(body.note, 'Note', 500);
  if (status === 'estimate_sent') await c.requireDesk(business);
  return repo.transaction(async (db) => {
    const job = await lockJob(db, business, jobId);
    requireOpen(job);
    if (status === 'estimate_sent' && !job.estimate_version) fail(`Write the estimate on ${job.job_no} before sending it to the owner`, 409);
    if (!(MOVES[job.status] || []).includes(status)) {
      fail(job.status === 'estimate_sent' ? `Job card ${job.job_no} waits for the owner's approval of the estimate: record it first`
        : `Job card ${job.job_no} is ${c.STATUS_WORDS[job.status]}: it cannot go to ${c.STATUS_WORDS[status]}`, 409);
    }
    if (job.status === 'ready' && !note) fail('Say why the vehicle goes back to work');
    await db.query('UPDATE garage_job_cards SET status=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, job.id, status, user.id]);
    const words = status === 'estimate_sent' ? `Estimate version ${job.estimate_version} sent to the owner` : null;
    await history(db, business, user, job, job.status, status, [words, note].filter(Boolean).join(' · ') || null);
    await repo.audit(db, business.id, user.id, 'job_card.status_changed', job.id, { jobNo: job.job_no, from: job.status, to: status, ...(note ? { note } : {}) });
    await repo.event(db, business.id, user.id, 'job_card.status_changed', 'job_card', job.id, { jobNo: job.job_no, from: job.status, to: status });
    return shape(business, await load(db, business, job.id));
  });
}

// The owner's approval of the estimate as it stands, for its total.
// body: { requestKey, approvedBy, channel: in_person | phone | whatsapp, approvedAt?, note? }
async function approve(business, user, jobId, body) {
  c.requireGarage(business);
  await c.requireDesk(business);
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf({ ...body, jobId: String(jobId) });
  const approvedBy = v.requiredString(typeof body.approvedBy === 'string' ? body.approvedBy : '', 'Who approved', 150);
  const channel = v.requiredEnum(body.channel, 'How they approved', c.CHANNELS);
  const note = c.optionalText(body.note, 'Note', 300);
  let approvedAt = null;
  if (c.given(body.approvedAt)) {
    const at = new Date(String(body.approvedAt));
    if (!Number.isFinite(at.getTime())) fail('When they approved must be a date and time');
    if (at.getTime() > Date.now() + 60000) fail('An approval cannot be in the future');
    approvedAt = at.toISOString();
  }
  return repo.transaction(async (db) => {
    const job = await lockJob(db, business, jobId);
    const done = await repo.one(db, 'SELECT job_card_id,request_hash FROM garage_estimate_approvals WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash || Number(done.job_card_id) !== Number(job.id)) fail('This request key was already used for different data', 409);
      return shape(business, await load(db, business, job.id));
    }
    requireOpen(job);
    if (!job.estimate_version) fail(`Write the estimate on ${job.job_no} before recording the owner's approval`, 409);
    if (job.approved_version === job.estimate_version) fail(`Version ${job.estimate_version} of the estimate on ${job.job_no} is approved already`, 409);
    const version = await repo.one(db, 'SELECT total,created_at FROM garage_estimate_versions WHERE business_id=$1 AND job_card_id=$2 AND version=$3', [business.id, job.id, job.estimate_version]);
    if (approvedAt && new Date(approvedAt).getTime() < new Date(version.created_at).getTime() - 60000) fail('An approval comes after the estimate it approves');
    await db.query(`INSERT INTO garage_estimate_approvals(business_id,job_card_id,version,amount,approved_by,channel,approved_at,note,request_key,request_hash,recorded_by)
      VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,now()),$8,$9,$10,$11)`, [business.id, job.id, job.estimate_version, version.total, approvedBy, channel, approvedAt, note, requestKey, hash, user.id]);
    const status = ['received', 'estimate_sent'].includes(job.status) ? 'approved' : job.status;
    await db.query('UPDATE garage_job_cards SET approved_version=$3,status=$4,updated_by=$5,updated_at=now() WHERE business_id=$1 AND id=$2',
      [business.id, job.id, job.estimate_version, status, user.id]);
    await history(db, business, user, job, job.status, status, [`Estimate version ${job.estimate_version} approved by ${approvedBy} ${c.CHANNEL_WORDS[channel]}`, note].filter(Boolean).join(' · '));
    await repo.audit(db, business.id, user.id, 'job_card.estimate_approved', job.id, { jobNo: job.job_no, version: job.estimate_version, amount: version.total, approvedBy, channel });
    await repo.event(db, business.id, user.id, 'job_card.estimate_approved', 'job_card', job.id, { jobNo: job.job_no, version: job.estimate_version, amount: version.total, channel });
    return shape(business, await load(db, business, job.id));
  });
}

// A message or call to the customer, kept in the job card's history. The
// message itself goes from the person's own WhatsApp (a wa.me link).
async function logMessage(business, user, jobId, body) {
  c.requireGarage(business);
  await access.require(business, 'garage.view');
  const channel = v.requiredEnum(body.channel ?? 'whatsapp', 'How', ['whatsapp', 'call', 'sms']);
  const stage = v.requiredEnum(body.stage ?? 'update', 'Message', ['received', 'estimate', 'ready', 'delayed', 'reminder', 'update']);
  return repo.transaction(async (db) => {
    const job = await lockJob(db, business, jobId);
    const how = { whatsapp: 'WhatsApp sent', call: 'Called the customer', sms: 'SMS sent' };
    const what = { received: 'vehicle received', estimate: 'estimate for approval', ready: 'ready to collect', delayed: 'running late', reminder: 'collection reminder', update: 'update' };
    const note = `${how[channel]}: ${what[stage]}${body.note ? ` · ${c.optionalText(body.note, 'Note', 300)}` : ''}`;
    await history(db, business, user, job, job.status, job.status, note);
    await repo.audit(db, business.id, user.id, 'job_card.customer_told', job.id, { jobNo: job.job_no, channel, stage });
    return { logged: true, note };
  });
}

// --- Cancelling, the advance and its refund ------------------------------------------------------------

async function cancel(business, user, jobId, body) {
  c.requireGarage(business);
  await access.require(business, 'garage.cancel');
  const reason = v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Reason', 300);
  return repo.transaction(async (db) => {
    const job = await lockJob(db, business, jobId);
    // Asking again is the same cancellation.
    if (job.status === 'cancelled') return shape(business, await load(db, business, job.id));
    requireOpen(job);
    await db.query(`UPDATE garage_job_cards SET status='cancelled',cancel_reason=$3,cancelled_by=$4,cancelled_at=now(),updated_by=$4,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, job.id, reason, user.id]);
    await history(db, business, user, job, job.status, 'cancelled', reason);
    await repo.audit(db, business.id, user.id, 'job_card.cancelled', job.id, { jobNo: job.job_no, reason });
    await repo.event(db, business.id, user.id, 'job_card.cancelled', 'job_card', job.id, { jobNo: job.job_no, reason, advanceCollectionId: job.advance_collection_id || null });
    return shape(business, await load(db, business, job.id));
  });
}

// An advance taken after the job card was opened (once per job card).
// body: { requestKey, amount, method | methodId, reference? }
async function takeAdvance(business, user, jobId, body) {
  c.requireGarage(business);
  await c.requireDesk(business);
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf({ ...body, jobId: String(jobId) });
  const advance = await readAdvance(business, body);
  if (!advance) fail('Give the amount of the advance');
  return repo.transaction(async (db) => {
    const job = await lockJob(db, business, jobId);
    const done = await repo.one(db, 'SELECT id,request_hash FROM business_collections WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash || Number(done.id) !== Number(job.advance_collection_id)) fail('This request key was already used for different data', 409);
      return shape(business, await load(db, business, job.id));
    }
    requireOpen(job);
    if (job.advance_collection_id) {
      const receipt = await repo.one(db, 'SELECT collection_no FROM business_collections WHERE business_id=$1 AND id=$2', [business.id, job.advance_collection_id]);
      fail(`Job card ${job.job_no} already has its advance (${receipt.collection_no}): take more money when the job is billed`, 409);
    }
    if (Number(job.total) > 0 && money.paise(advance.amount) > money.paise(job.total)) fail(`The advance is part of the job's total: at most ${job.total}`);
    const contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, job.contact_id]);
    const receipt = await numbering.nextNumber(db, business.id, job.location_id, 'collection', user.id);
    const collection = await repo.one(db, `INSERT INTO business_collections(business_id,location_id,collection_no,series_id,contact_id,contact_name,amount,method,reference,notes,request_key,request_hash,created_by,method_name)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, [business.id, job.location_id, receipt.number, receipt.seriesId, contact.id, contact.name,
      advance.amount.toFixed(2), advance.method, advance.reference, `Advance on job card ${job.job_no}`, requestKey, hash, user.id, advance.methodName]);
    await db.query('UPDATE garage_job_cards SET advance_collection_id=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, job.id, collection.id, user.id]);
    await history(db, business, user, job, job.status, job.status, `Advance taken (${collection.collection_no})`);
    await repo.audit(db, business.id, user.id, 'collection.recorded', collection.id, { amount: collection.amount, method: collection.method, jobCard: job.job_no });
    await repo.event(db, business.id, user.id, 'collection.recorded', 'collection', collection.id, {
      collectionNo: collection.collection_no, contactId: contact.id, amount: collection.amount, method: collection.method });
    return shape(business, await load(db, business, job.id));
  });
}

// The advance of a cancelled job card, or what is left of it after billing,
// handed back by cash, UPI or bank with a reason and a manager's PIN
// (sales.refund); a numbered refund with a receipt.
// body: { amount? (all that is left), method | methodId, reference?, reason, approverId?, pin?, requestKey }
async function refundAdvance(business, user, jobId, body) {
  c.requireGarage(business);
  await access.require(business, 'garage.view');
  await access.require(business, 'sales.edit');
  const input = refunds().readRefund(body);
  const approval = await pins().readApproval(business, user, body, 'sales.refund', { reasonLabel: 'Reason for the refund' });
  return repo.transaction(async (db) => {
    const job = await lockJob(db, business, jobId);
    if (!job.advance_collection_id) fail(`Job card ${job.job_no} has no advance`, 409);
    if (c.OPEN.includes(job.status)) fail(`Job card ${job.job_no} is still open: the advance comes off the bill. Cancel the job card first to refund it.`, 409);
    const { refund, repeated } = await refunds().refundCollection(db, business, user, { collectionId: job.advance_collection_id, contactId: job.contact_id, input, approval,
      source: 'garage', label: job.job_no });
    if (!repeated) await history(db, business, user, job, job.status, job.status, `Advance refunded (${refund.refund_no}) — ${approval.reason}`);
    return { ...refund, job_no: job.job_no, repeated };
  });
}

// --- The board, the mechanics and the bell ------------------------------------------------------------

// The open job cards for the board, by status: every one for the desk, a
// mechanic's own for a mechanic. At the person's location when they work at one.
async function board(business) {
  c.requireGarage(business);
  await access.requireAny(business, ['garage.view', 'garage.edit']);
  const mine = c.seesAll(business) ? null : business.member_user_id;
  const rows = await repo.all(repo.pool, `SELECT * FROM (${JOBS_SQL}) y WHERE y.stage='open' AND ($2::bigint IS NULL OR y.location_id=$2)
      AND ($3::bigint IS NULL OR EXISTS (SELECT 1 FROM garage_job_card_mechanics m WHERE m.business_id=$1 AND m.job_card_id=y.id AND m.user_id=$3))
    ORDER BY y.promised_at NULLS LAST,y.id LIMIT 300`, [business.id, business.location_scope || null, mine]);
  const work = await repo.all(repo.pool, `SELECT job_card_id,count(*)::int AS lines,count(*) FILTER (WHERE done)::int AS done FROM garage_job_card_lines
    WHERE business_id=$1 AND job_card_id=ANY($2::bigint[]) GROUP BY job_card_id`, [business.id, rows.map((r) => r.id)]);
  const items = rows.map((r) => ({ ...r, work: work.find((w) => Number(w.job_card_id) === Number(r.id)) || { lines: 0, done: 0 } }));
  const counts = Object.fromEntries(c.OPEN.map((s) => [s, items.filter((r) => r.status === s).length]));
  const out = listShape(business, { items });
  return { items: out.items, counts: { ...counts, open: items.length, overdue: items.filter((r) => r.overdue).length }, mine: Boolean(mine) };
}

async function mechanicList(business) {
  c.requireGarage(business);
  await access.require(business, 'garage.view');
  return c.mechanics(repo.pool, business);
}

// The bell: job cards ready to deliver, and those past their promised time.
async function bell(business, base, limit) {
  const rows = await repo.all(repo.pool, `SELECT j.id,j.job_no,j.status,j.registration_no,j.customer_name,j.promised_at,j.updated_at
    FROM garage_job_cards j
    WHERE j.business_id=$1 AND (j.status='ready' OR (j.status NOT IN ('ready','delivered','cancelled') AND j.promised_at < now()))
      AND ($3::bigint IS NULL OR j.location_id=$3)
    ORDER BY (j.status='ready') DESC,j.promised_at LIMIT $2`, [business.id, limit, business.location_scope || null]);
  return rows.map((j) => {
    const ready = j.status === 'ready';
    return { id: `jobcard:${j.id}:${ready ? 'ready' : 'late'}`, severity: ready ? 'info' : 'warning', category: 'Job cards',
      title: ready ? `${j.job_no} is ready to deliver` : `${j.job_no} is past its promised time`,
      detail: `${j.registration_no} · ${j.customer_name}`,
      at: new Date(ready ? j.updated_at : j.promised_at).toISOString(), link: `${base}/job-cards/${j.id}` };
  });
}

module.exports = { open, detail, updateDetails, setMechanics, setStatus, approve, logMessage, cancel, takeAdvance, refundAdvance, board, mechanicList, bell,
  listShape, shape, load, lockJob, requireOpen, history, linesOf, claimOf, settingsOf, ADVANCE_SQL, FREE_SQL, derivedKey, hashOf };
