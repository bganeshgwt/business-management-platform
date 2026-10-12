const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const h = require('./healthCommon');
const clinic = require('./businessClinic.service');

// Laboratory (round 2, R2-HEALTH).
//
//   Tests       a test has parameters (CBC: Hb, WBC, platelets …), each with a
//               unit and reference ranges by sex and age band (and critical
//               limits); a profile is several tests sold together. A test or
//               profile may be the catalogue service it is billed as.
//   Order       ordered → collected → received → in process → resulted →
//               approved (report ready), or cancelled. One sample per sample
//               type, each with its own barcode label. A rejected sample is
//               collected again.
//   Results     typed once per parameter, flagged against the patient's
//               range (low / high / critical, or abnormal for a text answer),
//               with the range kept as it was used. Approval is the
//               pathologist's (lab.approve + their PIN); an approved report
//               is fixed by the database.
//   Referral    a test sent to an outside lab is recorded on the order (lab,
//               reference, its charge). A referral commission is recorded
//               only when the business switches it on (default off: an
//               ethical and legal question, see DECISIONS_ROUND2.md).
// Results are clinical data: only lab.edit, lab.approve or
// patients.view_clinical see them, and each read is written to business_audit.

const { fail, id, optionalId, text } = h;
const requireLab = (business) => {
  h.requireType(business, ['healthcare'], 'Lab screens');
  if (!business.modules.includes('lab')) fail('Laboratory is not switched on for this business. An owner can turn it on in Settings › Modules.', 403);
};
const SAMPLE_TYPES = ['blood', 'serum', 'plasma', 'urine', 'stool', 'swab', 'sputum', 'other'];
const seesResults = (business) => ['lab.edit', 'lab.approve', 'patients.view_clinical'].some((p) => access.can(business, p));
const DAY_YEARS = 365.25;

repo.addLists({
  'lab-tests': {
    sql: `SELECT t.*,s.label AS sku_label,s.price AS sku_price,
      (SELECT count(*)::int FROM lab_parameters p WHERE p.business_id=t.business_id AND p.test_id=t.id AND p.active) AS parameter_count,
      (SELECT string_agg(x.code,', ' ORDER BY m.sort_order) FROM lab_profile_tests m JOIN lab_tests x ON x.business_id=m.business_id AND x.id=m.test_id
        WHERE m.business_id=t.business_id AND m.profile_id=t.id) AS profile_codes
      FROM lab_tests t LEFT JOIN catalog_skus s ON s.business_id=t.business_id AND s.id=t.sku_id WHERE t.business_id=$1`,
    search: ['code', 'name', 'sample_type', 'method'], filters: { kind: 'kind', active: 'active', sample: 'sample_type' }, order: 'kind DESC,name',
  },
  'lab-orders': {
    sql: `SELECT o.id,o.order_no,o.contact_id,o.visit_id,o.status,o.priority,o.referred_by,o.created_at,o.approved_at,o.outside_lab,o.document_id,
      c.name AS patient_name,c.phone AS patient_phone,p.patient_no,p.sex,d.document_no,v.visit_no,(o.outside_lab IS NOT NULL) AS outside,
      (SELECT string_agg(t.code,', ' ORDER BY ot.id) FROM lab_order_tests ot JOIN lab_tests t ON t.business_id=ot.business_id AND t.id=ot.test_id
        WHERE ot.business_id=o.business_id AND ot.order_id=o.id) AS tests,
      (SELECT string_agg(s.barcode,' ' ORDER BY s.id) FROM lab_samples s WHERE s.business_id=o.business_id AND s.order_id=o.id) AS barcodes,
      (SELECT count(*)::int FROM lab_results r WHERE r.business_id=o.business_id AND r.order_id=o.id AND r.flag IN ('low','high','critical_low','critical_high','abnormal')) AS flagged
      FROM lab_orders o JOIN business_contacts c ON c.business_id=o.business_id AND c.id=o.contact_id
      JOIN health_patients p ON p.business_id=o.business_id AND p.contact_id=o.contact_id
      LEFT JOIN business_documents d ON d.business_id=o.business_id AND d.id=o.document_id
      LEFT JOIN health_visits v ON v.business_id=o.business_id AND v.id=o.visit_id WHERE o.business_id=$1`,
    search: ['order_no', 'patient_name', 'patient_phone', 'patient_no', 'barcodes', 'tests', 'referred_by', 'outside_lab'], date: 'created_at',
    filters: { status: 'status', priority: 'priority', patient: 'contact_id', outside: 'outside', visit: 'visit_id' }, order: "priority='urgent' DESC,created_at DESC,id DESC",
  },
});

// --- Tests and panels -------------------------------------------------------------------------

const num = (value, name) => (value === undefined || value === null || value === '' ? null : v.requiredNumber(Number(value), name, { min: -1e9, max: 1e9 }));
function readRanges(list, parameterName) {
  return v.requiredArray(list ?? [], `Reference ranges of ${parameterName}`).map((r) => {
    const sex = v.optionalEnum(r?.sex, 'Sex', ['any', 'female', 'male'], 'any');
    const fromYears = num(r.ageFrom, 'Age from (years)') ?? 0;
    const toYears = num(r.ageTo, 'Age to (years)') ?? 150;
    if (fromYears < 0 || toYears > 150 || toYears <= fromYears) fail(`${parameterName}: the age band must run from a lower to a higher age (0 to 150 years)`);
    const range = { sex, from: Math.round(fromYears * DAY_YEARS), to: Math.min(54750, Math.round(toYears * DAY_YEARS)), low: num(r.low, 'Low'), high: num(r.high, 'High'),
      criticalLow: num(r.criticalLow, 'Critical low'), criticalHigh: num(r.criticalHigh, 'Critical high'), normalText: text(r.normalText, 'Normal answer', 60) };
    if (range.low === null && range.high === null && !range.normalText) fail(`${parameterName}: give a low or high limit, or the normal answer`);
    if (range.low !== null && range.high !== null && range.high < range.low) fail(`${parameterName}: the high limit is below the low limit`);
    return range;
  });
}
function readTest(body) {
  const code = String(body.code ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,29}$/.test(code)) fail('The test code is letters, digits, dashes (up to 30), e.g. CBC');
  const kind = v.optionalEnum(body.kind, 'Kind', ['test', 'profile'], 'test');
  const parameters = kind === 'test' ? v.requiredArray(body.parameters ?? [], 'Parameters').map((p, index) => {
    const name = v.requiredString(p?.name, `Parameter ${index + 1}`, 120);
    const decimals = p.decimals === undefined || p.decimals === '' ? 1 : Number(p.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) fail(`${name}: decimals must be 0 to 4`);
    return { id: optionalId(p.id, 'Parameter'), name, unit: text(p.unit, 'Unit', 30), resultType: v.optionalEnum(p.resultType, 'Result type', ['numeric', 'text'], 'numeric'),
      decimals, active: v.requiredBoolean(p.active, 'Active', true), ranges: readRanges(p.ranges, name), sort: index };
  }) : [];
  if (kind === 'test' && !parameters.some((p) => p.active)) fail('A test needs at least one parameter');
  if (new Set(parameters.map((p) => p.name.toLowerCase())).size !== parameters.length) fail('Two parameters have the same name');
  const testIds = kind === 'profile' ? [...new Set(v.requiredArray(body.testIds, 'Tests in the profile').map((t) => id(t, 'Test')))] : [];
  if (kind === 'profile' && testIds.length < 2) fail('A profile has at least two tests');
  return {
    code, kind, name: v.requiredString(body.name, 'Test name', 150), skuId: optionalId(body.skuId, 'Billed as'),
    sampleType: v.optionalEnum(body.sampleType, 'Sample', SAMPLE_TYPES, 'blood'), container: text(body.container, 'Container', 60), method: text(body.method, 'Method', 100),
    turnaround: body.turnaroundHours === undefined || body.turnaroundHours === '' ? 24 : v.requiredNumber(Number(body.turnaroundHours), 'Report in (hours)', { min: 1, max: 720 }),
    active: v.requiredBoolean(body.active, 'Active', true), parameters, testIds,
  };
}

async function saveTest(business, user, testId, body) {
  requireLab(business);
  await access.require(business, 'lab.edit');
  const f = readTest(body);
  return repo.transaction(async (db) => {
    if (f.skuId) {
      const sku = await repo.one(db, `SELECT s.id FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id AND p.kind='service'
        WHERE s.business_id=$1 AND s.id=$2`, [business.id, f.skuId]);
      if (!sku) fail('The billed service was not found (it must be a service)', 404);
    }
    let test;
    if (testId) {
      const current = await repo.one(db, 'SELECT * FROM lab_tests WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(testId, 'Test')]);
      if (!current) fail('Test not found', 404);
      if (current.kind !== f.kind) fail('A test cannot become a profile or the other way round');
      test = await repo.one(db, `UPDATE lab_tests SET code=$3,name=$4,sku_id=$5,sample_type=$6,container=$7,method=$8,turnaround_hours=$9,active=$10 WHERE business_id=$1 AND id=$2 RETURNING *`,
        [business.id, current.id, f.code, f.name, f.skuId, f.sampleType, f.container, f.method, f.turnaround, f.active]);
    } else {
      test = await repo.one(db, `INSERT INTO lab_tests(business_id,code,name,kind,sku_id,sample_type,container,method,turnaround_hours,active,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [business.id, f.code, f.name, f.kind, f.skuId, f.sampleType, f.container, f.method, f.turnaround, f.active, user.id]);
    }
    if (f.kind === 'profile') {
      const members = await repo.all(db, "SELECT id FROM lab_tests WHERE business_id=$1 AND id=ANY($2::bigint[]) AND kind='test'", [business.id, f.testIds]);
      if (members.length !== f.testIds.length) fail('Every test in a profile must be a test of this lab (not another profile)', 404);
      await db.query('DELETE FROM lab_profile_tests WHERE business_id=$1 AND profile_id=$2', [business.id, test.id]);
      for (const [index, testIdValue] of f.testIds.entries()) {
        await db.query('INSERT INTO lab_profile_tests(business_id,profile_id,test_id,sort_order) VALUES($1,$2,$3,$4)', [business.id, test.id, testIdValue, index]);
      }
    } else {
      const kept = [];
      for (const p of f.parameters) {
        let row;
        if (p.id) {
          row = await repo.one(db, `UPDATE lab_parameters SET name=$4,unit=$5,result_type=$6,decimals=$7,sort_order=$8,active=$9 WHERE business_id=$1 AND test_id=$2 AND id=$3 RETURNING *`,
            [business.id, test.id, p.id, p.name, p.unit, p.resultType, p.decimals, p.sort, p.active]);
          if (!row) fail(`Parameter ${p.name} does not belong to this test`, 404);
        } else {
          row = await repo.one(db, `INSERT INTO lab_parameters(business_id,test_id,name,unit,result_type,decimals,sort_order,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT (business_id,test_id,name) DO UPDATE SET unit=EXCLUDED.unit,result_type=EXCLUDED.result_type,decimals=EXCLUDED.decimals,sort_order=EXCLUDED.sort_order,active=EXCLUDED.active
            RETURNING *`, [business.id, test.id, p.name, p.unit, p.resultType, p.decimals, p.sort, p.active]);
        }
        kept.push(row.id);
        await db.query('DELETE FROM lab_reference_ranges WHERE business_id=$1 AND parameter_id=$2', [business.id, row.id]);
        for (const r of p.ranges) {
          await db.query(`INSERT INTO lab_reference_ranges(business_id,parameter_id,sex,age_from_days,age_to_days,low,high,critical_low,critical_high,normal_text)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [business.id, row.id, r.sex, r.from, r.to, r.low, r.high, r.criticalLow, r.criticalHigh, r.normalText]);
        }
      }
      // Parameters left out are switched off (results already typed keep them).
      await db.query('UPDATE lab_parameters SET active=false WHERE business_id=$1 AND test_id=$2 AND NOT (id=ANY($3::bigint[]))', [business.id, test.id, kept]);
    }
    await repo.audit(db, business.id, user.id, testId ? 'lab.test_updated' : 'lab.test_created', test.id, { code: f.code, name: f.name });
    return testDetail(db, business, test.id);
  });
}

async function testDetail(db, business, testId) {
  const test = await repo.one(db, 'SELECT t.*,s.label AS sku_label,s.price AS sku_price FROM lab_tests t LEFT JOIN catalog_skus s ON s.business_id=t.business_id AND s.id=t.sku_id WHERE t.business_id=$1 AND t.id=$2',
    [business.id, testId]);
  if (!test) fail('Test not found', 404);
  const parameters = await repo.all(db, `SELECT p.*,COALESCE((SELECT json_agg(json_build_object('id',r.id,'sex',r.sex,'ageFrom',round(r.age_from_days/365.25,1),'ageTo',round(r.age_to_days/365.25,1),
      'low',r.low,'high',r.high,'criticalLow',r.critical_low,'criticalHigh',r.critical_high,'normalText',r.normal_text) ORDER BY r.sex,r.age_from_days)
      FROM lab_reference_ranges r WHERE r.business_id=p.business_id AND r.parameter_id=p.id),'[]') AS ranges
    FROM lab_parameters p WHERE p.business_id=$1 AND p.test_id=$2 ORDER BY p.active DESC,p.sort_order,p.id`, [business.id, test.id]);
  const members = test.kind === 'profile' ? await repo.all(db, `SELECT t.id,t.code,t.name FROM lab_profile_tests m JOIN lab_tests t ON t.business_id=m.business_id AND t.id=m.test_id
    WHERE m.business_id=$1 AND m.profile_id=$2 ORDER BY m.sort_order`, [business.id, test.id]) : [];
  return { ...test, parameters, tests: members };
}
async function test(business, testId) {
  requireLab(business);
  await access.require(business, 'lab.view');
  return testDetail(repo.pool, business, id(testId, 'Test'));
}

// --- Orders ----------------------------------------------------------------------------------

async function recompute(db, business, orderId) {
  const order = await repo.one(db, 'SELECT * FROM lab_orders WHERE business_id=$1 AND id=$2', [business.id, orderId]);
  if (['approved', 'cancelled'].includes(order.status)) return order;
  const facts = await repo.one(db, `SELECT
      (SELECT count(*)::int FROM lab_samples WHERE business_id=$1 AND order_id=$2) AS samples,
      (SELECT count(*)::int FROM lab_samples WHERE business_id=$1 AND order_id=$2 AND status IN ('collected','received')) AS collected,
      (SELECT count(*)::int FROM lab_samples WHERE business_id=$1 AND order_id=$2 AND status='received') AS received,
      (SELECT count(*)::int FROM lab_order_tests ot JOIN lab_parameters p ON p.business_id=ot.business_id AND p.test_id=ot.test_id AND p.active
        WHERE ot.business_id=$1 AND ot.order_id=$2) AS expected,
      (SELECT count(*)::int FROM lab_results WHERE business_id=$1 AND order_id=$2) AS results`, [business.id, orderId]);
  let status = 'ordered';
  if (facts.expected > 0 && facts.results >= facts.expected) status = 'resulted';
  else if (facts.results > 0) status = 'in_process';
  else if (facts.samples && facts.received === facts.samples) status = 'received';
  else if (facts.samples && facts.collected === facts.samples) status = 'collected';
  if (status !== order.status) {
    return repo.one(db, 'UPDATE lab_orders SET status=$3,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *', [business.id, orderId, status]);
  }
  return order;
}

async function createOrder(business, user, body) {
  requireLab(business);
  await access.require(business, 'lab.create');
  const key = h.requestKey(body.requestKey);
  const hash = h.hashOf(body);
  const chosen = [...new Set(v.requiredArray(body.testIds, 'Tests').map((t) => id(t, 'Test')))];
  if (!chosen.length || chosen.length > 40) fail('Choose between 1 and 40 tests');
  const bill = body.bill === true;
  if (bill) await access.require(business, 'sales.create');
  let paidNow = null;
  if (bill && body.payment) {
    await access.require(business, 'sales.edit');
    const amount = body.payment.amount === 'full' ? 'full' : core.decimal(body.payment.amount, 'Amount paid now', 2, 0, 100000000);
    paidNow = amount === 'full' || amount > 0 ? { amount, method: v.requiredEnum(body.payment.method, 'Payment method', ['cash', 'card', 'upi', 'bank', 'cheque']), reference: text(body.payment.reference, 'Payment reference', 100) } : null;
  }
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM lab_orders WHERE business_id=$1 AND request_key=$2', [business.id, key]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for a different order', 409);
      return orderDetail(db, business, old.id, { log: false });
    }
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.locationId, 'Location')]);
    if (!location) fail('Location not found', 404);
    let contactId = optionalId(body.contactId, 'Patient');
    let visit = null;
    if (body.visitId) {
      visit = await repo.one(db, 'SELECT * FROM health_visits WHERE business_id=$1 AND id=$2', [business.id, id(body.visitId, 'Visit')]);
      if (!visit) fail('Visit not found', 404);
      if (contactId && contactId !== Number(visit.contact_id)) fail('The visit belongs to another patient');
      contactId = Number(visit.contact_id);
    }
    if (!contactId) fail('Choose the patient');
    const patient = await repo.one(db, 'SELECT * FROM health_patients WHERE business_id=$1 AND contact_id=$2', [business.id, contactId]);
    if (!patient) fail('Register this person as a patient (with consent) before ordering tests', 409, { reason: 'not_a_patient' });
    await clinic.requireConsent(db, business, contactId);
    const picked = await repo.all(db, 'SELECT * FROM lab_tests WHERE business_id=$1 AND id=ANY($2::bigint[]) AND active', [business.id, chosen]);
    if (picked.length !== chosen.length) fail('A test was not found or is switched off', 404);
    // Profiles open into their tests; a test ordered twice is done once.
    const tests = new Map();
    for (const t of chosen.map((cid) => picked.find((p) => Number(p.id) === cid))) {
      if (t.kind === 'profile') {
        const members = await repo.all(db, `SELECT x.* FROM lab_profile_tests m JOIN lab_tests x ON x.business_id=m.business_id AND x.id=m.test_id
          WHERE m.business_id=$1 AND m.profile_id=$2 ORDER BY m.sort_order`, [business.id, t.id]);
        for (const m of members) if (!tests.has(Number(m.id))) tests.set(Number(m.id), { test: m, profileId: t.id });
      } else if (!tests.has(Number(t.id))) tests.set(Number(t.id), { test: t, profileId: null });
    }
    let documentId = optionalId(body.documentId, 'Bill');
    if (documentId) {
      const doc = await repo.one(db, "SELECT id,contact_id FROM business_documents WHERE business_id=$1 AND id=$2 AND kind='sale'", [business.id, documentId]);
      if (!doc || Number(doc.contact_id) !== contactId) fail('That bill is not this patient\'s', 409);
    }
    if (bill) {
      if (documentId) fail('This order already names its bill');
      const lines = picked.filter((t) => t.sku_id).map((t) => ({ skuId: Number(t.sku_id), quantity: '1' }));
      if (!lines.length) fail('None of these tests is linked to a billable service; bill them on the Sales screen');
      const input = { kind: 'sale', locationId: location.id, contactId, lines, payment: body.payment, notes: 'Lab tests' };
      const doc = await core.postDocument(db, business, user, input, { kind: 'sale', requestKey: key, hash, lines, paidNow });
      documentId = doc.id;
    }
    const orderNo = await h.nextNumber(db, business.id, 'lab_order');
    const order = await repo.one(db, `INSERT INTO lab_orders(business_id,order_no,location_id,contact_id,visit_id,referred_by,priority,document_id,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [business.id, orderNo, location.id, contactId, visit?.id || null,
      text(body.referredBy, 'Referred by', 150) || null, v.optionalEnum(body.priority, 'Priority', ['routine', 'urgent'], 'routine'), documentId, text(body.notes, 'Notes', 500), key, hash, user.id]);
    const samples = new Map();
    for (const { test: t, profileId } of tests.values()) {
      if (!samples.has(t.sample_type)) {
        const barcode = await h.nextNumber(db, business.id, 'sample', 7);
        samples.set(t.sample_type, await repo.one(db, 'INSERT INTO lab_samples(business_id,order_id,barcode,sample_type,container) VALUES($1,$2,$3,$4,$5) RETURNING *',
          [business.id, order.id, barcode, t.sample_type, t.container]));
      }
      await db.query('INSERT INTO lab_order_tests(business_id,order_id,test_id,profile_id,sample_id) VALUES($1,$2,$3,$4,$5)', [business.id, order.id, t.id, profileId, samples.get(t.sample_type).id]);
    }
    await repo.audit(db, business.id, user.id, 'lab.order_created', order.id, { orderNo, patientNo: patient.patient_no, tests: [...tests.values()].map((x) => x.test.code), billed: Boolean(documentId) });
    await repo.event(db, business.id, user.id, 'lab.order_created', 'lab_order', order.id, { orderNo, contactId, visitId: visit?.id || null });
    return orderDetail(db, business, order.id, { log: false });
  });
}

async function sampleAction(business, user, sampleId, body) {
  requireLab(business);
  await access.require(business, 'lab.create');
  const action = v.requiredEnum(body.action, 'Action', ['collect', 'receive', 'reject']);
  return repo.transaction(async (db) => {
    const sample = await repo.one(db, 'SELECT s.*,o.status AS order_status FROM lab_samples s JOIN lab_orders o ON o.business_id=s.business_id AND o.id=s.order_id WHERE s.business_id=$1 AND s.id=$2 FOR UPDATE OF s',
      [business.id, id(sampleId, 'Sample')]);
    if (!sample) fail('Sample not found', 404);
    if (['approved', 'cancelled'].includes(sample.order_status)) fail('This order is closed', 409);
    if (action === 'collect') {
      if (!['awaited', 'rejected'].includes(sample.status)) fail('This sample is already collected', 409);
      await db.query("UPDATE lab_samples SET status='collected',collected_at=now(),collected_by=$3,received_at=NULL,received_by=NULL,reject_reason=NULL WHERE business_id=$1 AND id=$2", [business.id, sample.id, user.id]);
    } else if (action === 'receive') {
      if (sample.status !== 'collected') fail('Collect the sample before receiving it in the lab', 409);
      await db.query("UPDATE lab_samples SET status='received',received_at=now(),received_by=$3 WHERE business_id=$1 AND id=$2", [business.id, sample.id, user.id]);
    } else {
      const reason = v.requiredString(body.reason, 'Why the sample was rejected', 300);
      if (sample.status === 'awaited') fail('Only a collected sample can be rejected', 409);
      await db.query("UPDATE lab_samples SET status='rejected',reject_reason=$3 WHERE business_id=$1 AND id=$2", [business.id, sample.id, reason]);
    }
    await repo.audit(db, business.id, user.id, `lab.sample_${action === 'collect' ? 'collected' : action === 'receive' ? 'received' : 'rejected'}`, sample.id, { barcode: sample.barcode });
    const order = await recompute(db, business, sample.order_id);
    return repo.one(db, 'SELECT s.*,$3::text AS order_status FROM lab_samples s WHERE business_id=$1 AND id=$2', [business.id, sample.id, order.status]);
  });
}
// A scanned barcode opens its sample.
async function sampleByBarcode(business, barcode) {
  requireLab(business);
  await access.require(business, 'lab.view');
  const code = String(barcode || '').trim().toUpperCase();
  const row = await repo.one(repo.pool, 'SELECT s.*,o.order_no FROM lab_samples s JOIN lab_orders o ON o.business_id=s.business_id AND o.id=s.order_id WHERE s.business_id=$1 AND s.barcode=$2', [business.id, code]);
  if (!row) fail('No sample with that barcode', 404);
  return row;
}

// The patient's reference range for one parameter (sex-specific beats "any",
// a narrower age band beats a wider one) and the flag of a value.
function rangeFor(ranges, sex, ageDays) {
  const fits = ranges.filter((r) => (r.sex === 'any' || r.sex === sex) && ageDays >= r.age_from_days && ageDays < r.age_to_days);
  fits.sort((a, b) => (a.sex === 'any') - (b.sex === 'any') || (a.age_to_days - a.age_from_days) - (b.age_to_days - b.age_from_days));
  return fits[0] || null;
}
const fmt = (n) => (n === null || n === undefined ? null : String(Number(n)));
function rangeText(range, unit) {
  if (!range) return null;
  if (range.normal_text && range.low === null && range.high === null) return range.normal_text;
  const u = unit ? ` ${unit}` : '';
  if (range.low !== null && range.high !== null) return `${fmt(range.low)} – ${fmt(range.high)}${u}`;
  if (range.high !== null) return `< ${fmt(range.high)}${u}`;
  return `> ${fmt(range.low)}${u}`;
}
function flagOf(range, parameter, value) {
  if (!range) return 'none';
  if (parameter.result_type === 'text') return range.normal_text ? (String(value).trim().toLowerCase() === range.normal_text.trim().toLowerCase() ? 'normal' : 'abnormal') : 'none';
  const n = Number(value);
  if (range.critical_low !== null && n < Number(range.critical_low)) return 'critical_low';
  if (range.critical_high !== null && n > Number(range.critical_high)) return 'critical_high';
  if (range.low !== null && n < Number(range.low)) return 'low';
  if (range.high !== null && n > Number(range.high)) return 'high';
  return 'normal';
}

async function enterResults(business, user, orderId, body) {
  requireLab(business);
  await access.require(business, 'lab.edit');
  const list = v.requiredArray(body.results, 'Results');
  if (!list.length || list.length > 300) fail('Enter between 1 and 300 results');
  return repo.transaction(async (db) => {
    const order = await repo.one(db, 'SELECT * FROM lab_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(orderId, 'Lab order')]);
    if (!order) fail('Lab order not found', 404);
    if (['approved', 'cancelled'].includes(order.status)) fail('This order is closed; its results cannot change', 409);
    const patient = await repo.one(db, 'SELECT * FROM health_patients WHERE business_id=$1 AND contact_id=$2', [business.id, order.contact_id]);
    const ageDays = h.ageOn(patient, await h.today(db, business)).days;
    let saved = 0;
    for (const input of list) {
      const orderTest = await repo.one(db, `SELECT ot.*,s.status AS sample_status FROM lab_order_tests ot JOIN lab_samples s ON s.business_id=ot.business_id AND s.id=ot.sample_id
        WHERE ot.business_id=$1 AND ot.order_id=$2 AND ot.id=$3`, [business.id, order.id, id(input?.orderTestId, 'Ordered test')]);
      if (!orderTest) fail('That test is not on this order', 404);
      if (orderTest.sample_status !== 'received' && !order.outside_lab) fail('Receive the sample in the lab before entering its results', 409);
      const parameter = await repo.one(db, 'SELECT * FROM lab_parameters WHERE business_id=$1 AND id=$2 AND test_id=$3', [business.id, id(input.parameterId, 'Parameter'), orderTest.test_id]);
      if (!parameter) fail('That parameter is not part of the test', 404);
      if (input.value === null || input.value === undefined || String(input.value).trim() === '') {
        await db.query('DELETE FROM lab_results WHERE business_id=$1 AND order_test_id=$2 AND parameter_id=$3', [business.id, orderTest.id, parameter.id]);
        continue;
      }
      let numeric = null, textValue = null;
      if (parameter.result_type === 'numeric') {
        numeric = v.requiredNumber(Number(String(input.value).trim()), parameter.name, { min: -1e9, max: 1e9 });
        numeric = Number(numeric.toFixed(Math.max(parameter.decimals, 0)));
      } else textValue = v.requiredString(String(input.value), parameter.name, 200);
      const ranges = await repo.all(db, 'SELECT * FROM lab_reference_ranges WHERE business_id=$1 AND parameter_id=$2', [business.id, parameter.id]);
      const range = rangeFor(ranges, patient.sex, ageDays);
      const flag = flagOf(range, parameter, numeric ?? textValue);
      await db.query(`INSERT INTO lab_results(business_id,order_id,order_test_id,parameter_id,value_numeric,value_text,unit,range_text,flag,entered_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (business_id,order_test_id,parameter_id) DO UPDATE SET value_numeric=EXCLUDED.value_numeric,value_text=EXCLUDED.value_text,unit=EXCLUDED.unit,
          range_text=EXCLUDED.range_text,flag=EXCLUDED.flag,entered_by=EXCLUDED.entered_by,updated_at=now()`,
      [business.id, order.id, orderTest.id, parameter.id, numeric, textValue, parameter.unit, rangeText(range, parameter.unit), flag, user.id]);
      saved += 1;
    }
    await repo.audit(db, business.id, user.id, 'lab.results_entered', order.id, { orderNo: order.order_no, results: saved });
    await recompute(db, business, order.id);
    return orderDetail(db, business, order.id, { log: false, forceResults: true });
  });
}

async function approve(business, user, orderId, body) {
  requireLab(business);
  await access.require(business, 'lab.approve');
  const signer = await h.verifySignature(business, 'pathologist', body.signoff, 'Approving a report');
  return repo.transaction(async (db) => {
    const order = await repo.one(db, 'SELECT * FROM lab_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(orderId, 'Lab order')]);
    if (!order) fail('Lab order not found', 404);
    if (order.status === 'approved') return orderDetail(db, business, order.id, { log: false, forceResults: true });
    const current = await recompute(db, business, order.id);
    if (current.status !== 'resulted') fail('Enter every result before approving the report', 409);
    await db.query("UPDATE lab_orders SET status='approved',approved_by=$3,approved_signatory_id=$4,approved_at=now(),updated_at=now() WHERE business_id=$1 AND id=$2",
      [business.id, order.id, signer.user_id, signer.id]);
    const flagged = await repo.one(db, "SELECT count(*)::int AS n FROM lab_results WHERE business_id=$1 AND order_id=$2 AND flag IN ('critical_low','critical_high')", [business.id, order.id]);
    await repo.audit(db, business.id, signer.user_id, 'lab.report_approved', order.id, { orderNo: order.order_no, pathologist: signer.name, enteredBy: user.id });
    await repo.event(db, business.id, signer.user_id, 'lab.report_ready', 'lab_order', order.id, { orderNo: order.order_no, contactId: order.contact_id, visitId: order.visit_id, critical: flagged.n });
    return orderDetail(db, business, order.id, { log: false, forceResults: true });
  });
}

async function cancelOrder(business, user, orderId, body) {
  requireLab(business);
  await access.require(business, 'lab.create');
  const reason = v.requiredString(body.reason, 'Reason', 300);
  return repo.transaction(async (db) => {
    const order = await repo.one(db, 'SELECT * FROM lab_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(orderId, 'Lab order')]);
    if (!order) fail('Lab order not found', 404);
    if (['approved', 'cancelled'].includes(order.status)) fail('This order is already closed', 409);
    await db.query("UPDATE lab_orders SET status='cancelled',cancel_reason=$3,updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, order.id, reason]);
    await repo.audit(db, business.id, user.id, 'lab.order_cancelled', order.id, { orderNo: order.order_no, reason, billed: Boolean(order.document_id) });
    return orderDetail(db, business, order.id, { log: false });
  });
}

// Sent to an outside lab: the lab, its reference and charge; a referral
// commission only when the business allows it (setting, default off).
async function refer(business, user, orderId, body) {
  requireLab(business);
  await access.require(business, 'lab.create');
  const outsideLab = v.requiredString(body.outsideLab, 'Outside lab', 150);
  const charge = body.outsideCharge === undefined || body.outsideCharge === '' || body.outsideCharge === null ? null : core.decimal(body.outsideCharge, 'Outside lab charge', 2, 0, 10000000);
  return repo.transaction(async (db) => {
    const order = await repo.one(db, 'SELECT * FROM lab_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(orderId, 'Lab order')]);
    if (!order) fail('Lab order not found', 404);
    if (['approved', 'cancelled'].includes(order.status)) fail('This order is closed', 409);
    const settings = await h.settings(db, business.id);
    let commission = null;
    if (body.referralCommission !== undefined && body.referralCommission !== null && body.referralCommission !== '') {
      if (!settings.referral_commission_enabled) fail('Referral commissions are switched off for this business (Clinic settings).', 409, { reason: 'referral_commission_off' });
      commission = core.decimal(body.referralCommission, 'Referral commission', 2, 0, 10000000);
    } else if (settings.referral_commission_enabled && Number(settings.referral_commission_percent) > 0) {
      const billed = order.document_id ? await repo.one(db, 'SELECT total FROM business_documents WHERE business_id=$1 AND id=$2', [business.id, order.document_id]) : null;
      const basis = billed ? Number(billed.total) : charge || 0;
      commission = Math.round(basis * Number(settings.referral_commission_percent)) / 100;
    }
    const row = await repo.one(db, `UPDATE lab_orders SET outside_lab=$3,outside_ref_no=$4,outside_charge=$5,referral_commission=$6,outside_sent_at=now(),updated_at=now()
      WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, order.id, outsideLab, text(body.referenceNo, 'Outside lab reference', 60), charge === null ? null : charge.toFixed(2),
      commission === null ? null : commission.toFixed(2)]);
    await repo.audit(db, business.id, user.id, 'lab.order_referred', order.id, { orderNo: order.order_no, outsideLab, charge, commission });
    return row;
  });
}

// An order: who, which tests, samples and status for anyone with lab.view;
// the results only for those who may see them (and the read is logged).
async function orderDetail(db, business, orderId, { log = true, forceResults = false } = {}) {
  const order = await repo.one(db, `SELECT o.*,c.name AS patient_name,c.phone AS patient_phone,c.address AS patient_address,p.patient_no,p.sex,p.date_of_birth,p.age_years,p.created_at AS registered_at,
      d.document_no,d.total AS bill_total,v.visit_no,g.name AS pathologist_name,g.qualification AS pathologist_qualification,g.registration_no AS pathologist_reg_no,
      l.name AS location_name,u.name AS created_by_name
    FROM lab_orders o JOIN business_contacts c ON c.business_id=o.business_id AND c.id=o.contact_id JOIN health_patients p ON p.business_id=o.business_id AND p.contact_id=o.contact_id
    JOIN business_locations l ON l.business_id=o.business_id AND l.id=o.location_id JOIN users u ON u.id=o.created_by
    LEFT JOIN business_documents d ON d.business_id=o.business_id AND d.id=o.document_id LEFT JOIN health_visits v ON v.business_id=o.business_id AND v.id=o.visit_id
    LEFT JOIN health_signatories g ON g.business_id=o.business_id AND g.id=o.approved_signatory_id WHERE o.business_id=$1 AND o.id=$2`, [business.id, orderId]);
  if (!order) fail('Lab order not found', 404);
  const [samples, tests] = await Promise.all([
    repo.all(db, `SELECT s.*,cu.name AS collected_by_name,ru.name AS received_by_name FROM lab_samples s LEFT JOIN users cu ON cu.id=s.collected_by LEFT JOIN users ru ON ru.id=s.received_by
      WHERE s.business_id=$1 AND s.order_id=$2 ORDER BY s.id`, [business.id, order.id]),
    repo.all(db, `SELECT ot.id,ot.test_id,ot.sample_id,ot.profile_id,t.code,t.name,t.method,t.sample_type,pt.name AS profile_name FROM lab_order_tests ot
      JOIN lab_tests t ON t.business_id=ot.business_id AND t.id=ot.test_id LEFT JOIN lab_tests pt ON pt.business_id=ot.business_id AND pt.id=ot.profile_id
      WHERE ot.business_id=$1 AND ot.order_id=$2 ORDER BY ot.id`, [business.id, order.id]),
  ]);
  const age = h.ageOn({ date_of_birth: order.date_of_birth, age_years: order.age_years, created_at: order.registered_at }, new Date(order.created_at).toISOString().slice(0, 10)).years;
  const results = forceResults || seesResults(business);
  if (results) {
    const params = await repo.all(db, `SELECT p.id AS parameter_id,p.test_id,p.name,p.unit,p.result_type,p.decimals,p.sort_order,p.active,
        r.value_numeric,r.value_text,r.flag,r.range_text,r.updated_at AS entered_at
      FROM lab_order_tests ot JOIN lab_parameters p ON p.business_id=ot.business_id AND p.test_id=ot.test_id
      LEFT JOIN lab_results r ON r.business_id=ot.business_id AND r.order_test_id=ot.id AND r.parameter_id=p.id
      WHERE ot.business_id=$1 AND ot.order_id=$2 AND (p.active OR r.id IS NOT NULL) ORDER BY p.sort_order,p.id`, [business.id, order.id]);
    for (const t of tests) t.parameters = params.filter((p) => String(p.test_id) === String(t.test_id));
    // The range each empty parameter would be judged by, for the entry screen.
    const ageDays = h.ageOn({ date_of_birth: order.date_of_birth, age_years: order.age_years, created_at: order.registered_at }, new Date().toISOString().slice(0, 10)).days;
    const ranges = params.length ? await repo.all(db, 'SELECT * FROM lab_reference_ranges WHERE business_id=$1 AND parameter_id=ANY($2::bigint[])', [business.id, params.map((p) => p.parameter_id)]) : [];
    for (const p of params) if (!p.range_text) p.range_text = rangeText(rangeFor(ranges.filter((r) => String(r.parameter_id) === String(p.parameter_id)), order.sex, ageDays), p.unit);
    if (log) await clinic.logClinicalView(business, order.contact_id, 'lab results', { orderNo: order.order_no });
  }
  return { ...order, age, samples, tests, results_visible: results };
}
async function order(business, orderId) {
  requireLab(business);
  await access.require(business, 'lab.view');
  return orderDetail(repo.pool, business, id(orderId, 'Lab order'));
}
// The printable report (approved orders only).
async function report(business, orderId) {
  requireLab(business);
  await access.require(business, 'lab.print');
  const detail = await orderDetail(repo.pool, business, id(orderId, 'Lab order'), { log: false, forceResults: true });
  if (detail.status !== 'approved') fail('The report is printed once the pathologist approves it', 409);
  const [settings, seller] = await Promise.all([h.settings(repo.pool, business.id),
    repo.one(repo.pool, 'SELECT display_name,legal_name,address_line1,address_line2,city,postal_code,phone,email FROM business_settings WHERE business_id=$1', [business.id])]);
  await repo.transaction((db) => repo.audit(db, business.id, business.member_user_id, 'lab.report_printed', detail.id, { orderNo: detail.order_no, contactId: detail.contact_id }));
  return { ...detail, lab: { name: settings.lab_name || seller?.display_name || business.name, registration: settings.lab_registration, footer: settings.report_footer, ...seller } };
}

// The lab's day: open orders by state, and today's counts.
async function worklist(business) {
  requireLab(business);
  await access.require(business, 'lab.view');
  return repo.one(repo.pool, `SELECT
    (SELECT count(*)::int FROM lab_orders WHERE business_id=$1 AND status='ordered') AS awaiting_collection,
    (SELECT count(*)::int FROM lab_orders WHERE business_id=$1 AND status='collected') AS awaiting_receipt,
    (SELECT count(*)::int FROM lab_orders WHERE business_id=$1 AND status IN ('received','in_process')) AS in_process,
    (SELECT count(*)::int FROM lab_orders WHERE business_id=$1 AND status='resulted') AS awaiting_approval,
    (SELECT count(*)::int FROM lab_orders o JOIN businesses b ON b.id=o.business_id WHERE o.business_id=$1 AND o.status='approved'
      AND (o.approved_at AT TIME ZONE b.timezone)::date=(now() AT TIME ZONE b.timezone)::date) AS approved_today,
    (SELECT count(*)::int FROM lab_orders WHERE business_id=$1 AND priority='urgent' AND status NOT IN ('approved','cancelled')) AS urgent_open,
    (SELECT count(*)::int FROM lab_orders WHERE business_id=$1 AND outside_lab IS NOT NULL AND status NOT IN ('approved','cancelled')) AS outside_open`, [business.id]);
}

module.exports = { requireLab, saveTest, test, createOrder, sampleAction, sampleByBarcode, enterResults, approve, cancelOrder, refer, order, report, worklist, rangeFor, flagOf };
