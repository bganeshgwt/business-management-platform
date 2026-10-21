const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const h = require('./healthCommon');

// Lab quality (round 3):
//
//   Report      every signed report is kept as signed (results, ranges, flags,
//   versions    who signed). A correction after signing is an amendment: the
//               pathologist reopens the report with a reason (and their PIN),
//               corrects it and signs again; the new report says it amends
//               the earlier one, which can still be printed, marked superseded.
//   QC          control materials per parameter (lot, level, target mean and
//               SD) and the runs measured on them. Each run is judged by the
//               Westgard rules: 1-2s warns; 1-3s, 2-2s, R-4s, 4-1s and 10x
//               reject. While a parameter's latest QC run today is rejected,
//               patient reports with that parameter cannot be signed.

const { fail, id, text } = h;
const requireLab = (business) => {
  h.requireType(business, ['healthcare'], 'Lab tests');
  if (!business.modules.includes('lab')) fail('The lab is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
};

// --- Report versions ----------------------------------------------------------------------

// The order's results as they stand, in report order: what a signed version keeps.
const snapshot = (db, businessId, orderId) => repo.one(db, `SELECT COALESCE(jsonb_agg(jsonb_build_object('test_code',t.code,'test_name',t.name,'parameter_id',p.id,'name',p.name,
    'value_numeric',r.value_numeric,'value_text',r.value_text,'unit',r.unit,'range_text',r.range_text,'flag',r.flag) ORDER BY ot.id,p.sort_order,p.id),'[]'::jsonb) AS results
  FROM lab_results r JOIN lab_order_tests ot ON ot.business_id=r.business_id AND ot.id=r.order_test_id
  JOIN lab_tests t ON t.business_id=ot.business_id AND t.id=ot.test_id
  JOIN lab_parameters p ON p.business_id=r.business_id AND p.id=r.parameter_id
  WHERE r.business_id=$1 AND r.order_id=$2`, [businessId, orderId]);

// Called by approve(), inside its transaction, once the order is approved.
async function recordVersion(db, business, order, signer) {
  const version = Number(order.version) + 1;
  const { results } = await snapshot(db, business.id, order.id);
  await db.query(`INSERT INTO lab_report_versions(business_id,order_id,version,results,amend_reason,signatory_id,approved_by,approved_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,now())`, [business.id, order.id, version, JSON.stringify(results), version > 1 ? order.amend_reason : null, signer.id, signer.user_id]);
  await db.query('UPDATE lab_orders SET version=$3,amend_reason=NULL,amend_requested_by=NULL,amend_requested_at=NULL WHERE business_id=$1 AND id=$2', [business.id, order.id, version]);
  return version;
}

// Reopens a signed report for correction. body: { reason, signoff: { signatoryId, pin } }
async function amend(business, user, orderId, body) {
  requireLab(business);
  await access.require(business, 'lab.approve');
  const reason = v.requiredString(body.reason, 'Reason for the amendment', 300);
  const signer = await h.verifySignature(business, 'pathologist', body.signoff, 'Amending a report');
  return repo.transaction(async (db) => {
    const order = await repo.one(db, 'SELECT * FROM lab_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(orderId, 'Lab order')]);
    if (!order) fail('Lab order not found', 404);
    access.requireLocation(business, order.location_id);
    if (order.status !== 'approved') fail('Only a signed report is amended; this one can still be corrected as it is', 409);
    await db.query(`UPDATE lab_orders SET status='resulted',approved_by=NULL,approved_signatory_id=NULL,approved_at=NULL,amend_reason=$3,amend_requested_by=$4,
      amend_requested_at=now(),updated_at=now() WHERE business_id=$1 AND id=$2`, [business.id, order.id, reason, signer.user_id]);
    await repo.audit(db, business.id, signer.user_id, 'lab.report_amend_started', order.id, { orderNo: order.order_no, version: order.version, reason, enteredBy: user.id });
    return { id: order.id, order_no: order.order_no, status: 'resulted', version: order.version, amend_reason: reason };
  });
}

// Every signed version of a report (newest first).
async function versions(business, orderId) {
  requireLab(business);
  await access.requireAny(business, ['lab.print', 'lab.approve', 'lab.edit']);
  const order = await repo.one(repo.pool, 'SELECT id,location_id,contact_id,order_no,version FROM lab_orders WHERE business_id=$1 AND id=$2', [business.id, id(orderId, 'Lab order')]);
  if (!order) fail('Lab order not found', 404);
  const rows = await repo.all(repo.pool, `SELECT x.id,x.version,x.amend_reason,x.approved_at,x.results,g.name AS pathologist_name,g.qualification AS pathologist_qualification,
      g.registration_no AS pathologist_reg_no,(x.version < o.version OR o.status<>'approved') AS superseded
    FROM lab_report_versions x JOIN lab_orders o ON o.business_id=x.business_id AND o.id=x.order_id
    LEFT JOIN health_signatories g ON g.business_id=x.business_id AND g.id=x.signatory_id
    WHERE x.business_id=$1 AND x.order_id=$2 ORDER BY x.version DESC`, [business.id, order.id]);
  return { order_id: order.id, order_no: order.order_no, current: order.version, versions: rows };
}

// --- QC -------------------------------------------------------------------------------------

repo.addLists({
  'lab-qc-materials': {
    sql: `SELECT m.*,p.name AS parameter_name,p.unit,t.code AS test_code,t.name AS test_name,
        (SELECT row_to_json(x) FROM (SELECT r.id,r.value,r.z,r.rules,r.outcome,r.run_at FROM lab_qc_runs r WHERE r.business_id=m.business_id AND r.material_id=m.id
          ORDER BY r.run_at DESC,r.id DESC LIMIT 1) x) AS last_run,
        (SELECT r.outcome FROM lab_qc_runs r JOIN businesses b ON b.id=r.business_id WHERE r.business_id=m.business_id AND r.material_id=m.id
          AND (r.run_at AT TIME ZONE b.timezone)::date=(now() AT TIME ZONE b.timezone)::date ORDER BY r.run_at DESC,r.id DESC LIMIT 1) AS today_outcome,
        (m.expires_on IS NOT NULL AND m.expires_on < (SELECT (now() AT TIME ZONE timezone)::date FROM businesses WHERE id=m.business_id)) AS expired
      FROM lab_qc_materials m JOIN lab_parameters p ON p.business_id=m.business_id AND p.id=m.parameter_id
      JOIN lab_tests t ON t.business_id=p.business_id AND t.id=p.test_id WHERE m.business_id=$1`,
    search: ['name', 'lot_no', 'parameter_name', 'test_code', 'test_name'], filters: { active: 'active', parameter: 'parameter_id' },
    order: 'active DESC,test_code,parameter_name,level',
  },
  'lab-qc-runs': {
    sql: `SELECT r.*,m.name AS material_name,m.lot_no,m.level,m.mean,m.sd,p.name AS parameter_name,p.unit,t.code AS test_code,u.name AS entered_by_name
      FROM lab_qc_runs r JOIN lab_qc_materials m ON m.business_id=r.business_id AND m.id=r.material_id
      JOIN lab_parameters p ON p.business_id=r.business_id AND p.id=r.parameter_id JOIN lab_tests t ON t.business_id=p.business_id AND t.id=p.test_id
      JOIN users u ON u.id=r.entered_by WHERE r.business_id=$1`,
    search: ['material_name', 'lot_no', 'parameter_name', 'test_code', 'note'], date: 'run_at',
    filters: { material: 'material_id', parameter: 'parameter_id', outcome: 'outcome' }, order: 'run_at DESC,id DESC',
  },
});

// body: { parameterId, name, lotNo, level, mean, sd, expiresOn, active }
async function saveMaterial(business, user, materialId, body) {
  requireLab(business);
  await access.require(business, 'lab.edit');
  const mean = v.requiredNumber(Number(body.mean), 'Target mean', { min: -1e9, max: 1e9 });
  const sd = v.requiredNumber(Number(body.sd), 'SD', { min: 0.0001, max: 1e9 });
  const fields = [v.requiredString(body.name, 'Control name', 120), v.requiredString(body.lotNo, 'Lot number', 40), text(body.level, 'Level', 20) || 'Level 1',
    mean, sd, h.optionalDate(body.expiresOn, 'Expiry date'), body.active !== false];
  return repo.transaction(async (db) => {
    if (materialId) {
      const old = await repo.one(db, 'SELECT * FROM lab_qc_materials WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(materialId, 'QC material')]);
      if (!old) fail('QC material not found', 404);
      const row = await repo.one(db, `UPDATE lab_qc_materials SET name=$3,lot_no=$4,level=$5,mean=$6,sd=$7,expires_on=$8,active=$9,updated_at=now()
        WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, old.id, ...fields]);
      await repo.audit(db, business.id, user.id, 'lab.qc_material_saved', old.id, { name: row.name, lot: row.lot_no, mean, sd, before: { mean: old.mean, sd: old.sd } });
      return row;
    }
    const parameter = await repo.one(db, `SELECT p.id FROM lab_parameters p WHERE p.business_id=$1 AND p.id=$2 AND p.result_type='numeric'`, [business.id, id(body.parameterId, 'Parameter')]);
    if (!parameter) fail('Choose a numeric parameter of one of your tests', 404);
    if (await repo.one(db, 'SELECT 1 FROM lab_qc_materials WHERE business_id=$1 AND parameter_id=$2 AND lot_no=$4 AND level=$3', [business.id, parameter.id, fields[2], fields[1]])) {
      fail('This control lot and level is already set up for the parameter', 409);
    }
    const row = await repo.one(db, `INSERT INTO lab_qc_materials(business_id,parameter_id,name,lot_no,level,mean,sd,expires_on,active,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [business.id, parameter.id, ...fields, user.id]);
    await repo.audit(db, business.id, user.id, 'lab.qc_material_saved', row.id, { name: row.name, lot: row.lot_no, mean, sd });
    return row;
  });
}

// The Westgard rules for a run, given the earlier runs of the same control
// (newest first) and today's latest run of the parameter's other controls.
function westgard(z, previous, others) {
  const rules = [];
  const side = Math.sign(z);
  if (Math.abs(z) > 3) rules.push('1-3s');
  const last = previous[0];
  if (Math.abs(z) > 2 && ((last && Math.abs(last) > 2 && Math.sign(last) === side) || others.some((o) => Math.abs(o) > 2 && Math.sign(o) === side))) rules.push('2-2s');
  if (Math.abs(z) > 2 && others.some((o) => Math.abs(o) > 2 && Math.sign(o) === -side)) rules.push('R-4s');
  const four = [z, ...previous.slice(0, 3)];
  if (four.length === 4 && (four.every((x) => x > 1) || four.every((x) => x < -1))) rules.push('4-1s');
  const ten = [z, ...previous.slice(0, 9)];
  if (ten.length === 10 && (ten.every((x) => x > 0) || ten.every((x) => x < 0))) rules.push('10x');
  if (rules.length) return { rules, outcome: 'rejected' };
  if (Math.abs(z) > 2) return { rules: ['1-2s'], outcome: 'warning' };
  return { rules: [], outcome: 'accepted' };
}

// body: { materialId, value, note?, correctiveAction? }
async function recordRun(business, user, body) {
  requireLab(business);
  await access.require(business, 'lab.edit');
  const value = v.requiredNumber(Number(body.value), 'Measured value', { min: -1e9, max: 1e9 });
  return repo.transaction(async (db) => {
    const material = await repo.one(db, 'SELECT *,expires_on::text AS expires_day FROM lab_qc_materials WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(body.materialId, 'QC material')]);
    if (!material) fail('QC material not found', 404);
    if (!material.active) fail('This control is no longer in use', 409);
    const day = await h.today(db, business);
    if (material.expires_day && material.expires_day < day) fail(`Control lot ${material.lot_no} has expired; set up the new lot`, 409);
    const z = Math.round(((value - Number(material.mean)) / Number(material.sd)) * 1000) / 1000;
    const previous = (await repo.all(db, 'SELECT z FROM lab_qc_runs WHERE business_id=$1 AND material_id=$2 ORDER BY run_at DESC,id DESC LIMIT 9', [business.id, material.id])).map((r) => Number(r.z));
    const others = (await repo.all(db, `SELECT DISTINCT ON (r.material_id) r.z FROM lab_qc_runs r JOIN businesses b ON b.id=r.business_id
      WHERE r.business_id=$1 AND r.parameter_id=$2 AND r.material_id<>$3 AND (r.run_at AT TIME ZONE b.timezone)::date=$4::date ORDER BY r.material_id,r.run_at DESC,r.id DESC`,
    [business.id, material.parameter_id, material.id, day])).map((r) => Number(r.z));
    const judged = westgard(z, previous, others);
    const note = text(body.note, 'Note', 300), corrective = text(body.correctiveAction, 'Corrective action', 300);
    const row = await repo.one(db, `INSERT INTO lab_qc_runs(business_id,material_id,parameter_id,value,z,rules,outcome,note,corrective_action,entered_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [business.id, material.id, material.parameter_id, value, z, judged.rules, judged.outcome, note, corrective, user.id]);
    await repo.audit(db, business.id, user.id, 'lab.qc_run', row.id, { materialId: material.id, value, z, outcome: judged.outcome, rules: judged.rules });
    return { ...row, mean: material.mean, sd: material.sd };
  });
}

// Today's QC by parameter: each control's latest run and the overall state
// (rejected, warning, accepted, not_run).
async function qcToday(business) {
  requireLab(business);
  await access.require(business, 'lab.view');
  const rows = await repo.all(repo.pool, `SELECT m.id AS material_id,m.name,m.lot_no,m.level,m.parameter_id,p.name AS parameter_name,t.code AS test_code,
      x.outcome,x.rules,x.z,x.run_at
    FROM lab_qc_materials m JOIN businesses b ON b.id=m.business_id JOIN lab_parameters p ON p.business_id=m.business_id AND p.id=m.parameter_id
    JOIN lab_tests t ON t.business_id=p.business_id AND t.id=p.test_id
    LEFT JOIN LATERAL (SELECT r.outcome,r.rules,r.z,r.run_at FROM lab_qc_runs r WHERE r.business_id=m.business_id AND r.material_id=m.id
      AND (r.run_at AT TIME ZONE b.timezone)::date=(now() AT TIME ZONE b.timezone)::date ORDER BY r.run_at DESC,r.id DESC LIMIT 1) x ON TRUE
    WHERE m.business_id=$1 AND m.active ORDER BY t.code,p.name,m.level`, [business.id]);
  const byParameter = new Map();
  for (const r of rows) {
    const key = String(r.parameter_id);
    if (!byParameter.has(key)) byParameter.set(key, { parameter_id: r.parameter_id, parameter_name: r.parameter_name, test_code: r.test_code, controls: [] });
    byParameter.get(key).controls.push(r);
  }
  const rank = { rejected: 3, not_run: 2, warning: 1, accepted: 0 };
  const parameters = [...byParameter.values()].map((p) => ({ ...p, status: p.controls.map((c) => c.outcome || 'not_run').sort((a, b) => rank[b] - rank[a])[0] }));
  const count = (s) => parameters.filter((p) => p.status === s).length;
  return { parameters, rejected: count('rejected'), not_run: count('not_run'), warning: count('warning'), accepted: count('accepted') };
}

// The parameters of an order whose QC is rejected today (signing is held).
async function rejectedQc(db, business, orderId) {
  return repo.all(db, `SELECT DISTINCT p.name,m.name AS control,m.level,x.rules FROM lab_order_tests ot
    JOIN lab_parameters p ON p.business_id=ot.business_id AND p.test_id=ot.test_id
    JOIN lab_qc_materials m ON m.business_id=p.business_id AND m.parameter_id=p.id AND m.active
    JOIN businesses b ON b.id=m.business_id
    JOIN LATERAL (SELECT r.outcome,r.rules FROM lab_qc_runs r WHERE r.business_id=m.business_id AND r.material_id=m.id
      AND (r.run_at AT TIME ZONE b.timezone)::date=(now() AT TIME ZONE b.timezone)::date ORDER BY r.run_at DESC,r.id DESC LIMIT 1) x ON x.outcome='rejected'
    WHERE ot.business_id=$1 AND ot.order_id=$2`, [business.id, orderId]);
}

// The QC state of an order's parameters today, for the order screen.
async function orderQc(db, business, orderId) {
  return repo.all(db, `SELECT p.id AS parameter_id,p.name,
      CASE WHEN count(m.id)=0 THEN 'no_control' WHEN bool_or(x.outcome='rejected') THEN 'rejected' WHEN bool_or(x.outcome IS NULL) THEN 'not_run'
        WHEN bool_or(x.outcome='warning') THEN 'warning' ELSE 'accepted' END AS status
    FROM lab_order_tests ot JOIN lab_parameters p ON p.business_id=ot.business_id AND p.test_id=ot.test_id AND p.result_type='numeric'
    JOIN businesses b ON b.id=ot.business_id
    LEFT JOIN lab_qc_materials m ON m.business_id=p.business_id AND m.parameter_id=p.id AND m.active
    LEFT JOIN LATERAL (SELECT r.outcome FROM lab_qc_runs r WHERE r.business_id=m.business_id AND r.material_id=m.id
      AND (r.run_at AT TIME ZONE b.timezone)::date=(now() AT TIME ZONE b.timezone)::date ORDER BY r.run_at DESC,r.id DESC LIMIT 1) x ON TRUE
    WHERE ot.business_id=$1 AND ot.order_id=$2 GROUP BY p.id,p.name HAVING count(m.id)>0 ORDER BY p.name`, [business.id, orderId]);
}

module.exports = { requireLab, snapshot, recordVersion, amend, versions, saveMaterial, westgard, recordRun, qcToday, rejectedQc, orderQc };
